import type {
  AnalysisResult,
  Cancellation,
  CatchDescriptor,
  ConditionDescriptor,
  SelectionArm,
  StatementDescriptor,
  StatementKind,
  StatementReference
} from '@visual-code-flow/shared';
import {
  asNode,
  childrenOf,
  nameOf,
  nodeList,
  CLASS_KINDS,
  FUNCTION_KINDS,
  type PhpNode
} from './ast.js';
import {
  checkCancellation,
  PhpAnalysisError,
  type PhpDocument,
  type PhpFunctionRecord
} from './document.js';

const LOOKUPS = new Set([
  'propertylookup',
  'nullsafepropertylookup',
  'staticlookup',
  'offsetlookup'
]);
const LITERALS = new Set([
  'number',
  'string',
  'boolean',
  'nullkeyword',
  'name',
  'identifier',
  'magic',
  'selfreference',
  'parentreference',
  'staticreference'
]);
const SHORT_AND = new Set(['&&', 'and']);
const SHORT_OR = new Set(['||', 'or']);
interface ChainStep {
  readonly node: PhpNode;
  readonly lookup: PhpNode;
}
interface Chain {
  readonly base: PhpNode;
  readonly steps: readonly ChainStep[];
}

/** PHP syntax -> language-neutral structured flow. Never evaluates PHP values. */
export class PhpStatementExtractor {
  private counter = 0;
  private depth = 0;
  private readonly diagnostics = new Set<string>();

  constructor(
    private readonly document: PhpDocument,
    private readonly fn: PhpFunctionRecord,
    private readonly cancellation?: Cancellation
  ) {}

  analyze(): AnalysisResult {
    checkCancellation(this.cancellation);
    const generator = this.descendants(this.fn.body).some(
      (node) => node.kind === 'yield' || node.kind === 'yieldfrom'
    );
    const statements = generator
      ? [
          this.opaque(
            this.fn.body,
            'Generator suspension and lazy execution are not modeled.',
            true
          )
        ]
      : this.fn.node.kind === 'arrowfunc'
        ? [...this.expression(this.fn.body), this.emit(this.fn.body, 'return', 'Implicit return')]
        : this.statement(this.fn.body);
    return { function: this.fn.descriptor, statements, diagnostics: [...this.diagnostics] };
  }

  private guard<T>(work: () => T): T {
    checkCancellation(this.cancellation);
    if (++this.depth > 128) throw new PhpAnalysisError('analysis-limit');
    try {
      return work();
    } finally {
      this.depth--;
    }
  }
  private id(node: PhpNode, purpose: string): string {
    if (++this.counter > 8_000) throw new PhpAnalysisError('analysis-limit');
    return `${this.fn.descriptor.symbolId}:${this.document.source.offsets(node)[0]}:${purpose}:${this.counter}`;
  }
  private label(node: PhpNode): string {
    const raw = this.document.source.slice(node).replace(/\s+/g, ' ').trim();
    const text = ['call', 'new'].includes(node.kind) ? raw.replace(/;$/, '') : raw;
    return text.length > 200 ? `${text.slice(0, 197)}...` : text || node.kind;
  }
  private emit(
    node: PhpNode,
    kind: StatementKind,
    label = this.label(node),
    extra: Partial<StatementDescriptor> = {}
  ): StatementDescriptor {
    return {
      id: this.id(node, kind),
      kind,
      label,
      location: this.document.source.span(node),
      ...extra
    };
  }
  private leaf(
    node: PhpNode,
    label: string,
    evaluation: readonly StatementDescriptor[] = [],
    constant?: boolean
  ): Extract<ConditionDescriptor, { kind: 'test' }> {
    return {
      kind: 'test',
      id: this.id(node, 'test'),
      label,
      location: this.document.source.span(node),
      evaluation,
      ...(constant === undefined ? {} : { constant })
    };
  }
  private bool(node: PhpNode): boolean | undefined {
    if (node.kind === 'boolean' && typeof node.value === 'boolean') return node.value;
    if (node.kind === 'nullkeyword') return false;
    return undefined;
  }
  private present(node: PhpNode, evaluation = this.expression(node)): ConditionDescriptor {
    const constant =
      node.kind === 'nullkeyword'
        ? false
        : ['boolean', 'string', 'number'].includes(node.kind)
          ? true
          : undefined;
    return this.leaf(node, `Value is set and not null: ${this.label(node)}`, evaluation, constant);
  }
  private descendants(root: PhpNode): PhpNode[] {
    const output: PhpNode[] = [];
    const stack = [root];
    while (stack.length) {
      checkCancellation(this.cancellation);
      const node = stack.pop()!;
      output.push(node);
      // Declaring a closure/class never executes its method/function bodies.
      if (FUNCTION_KINDS.has(node.kind) || CLASS_KINDS.has(node.kind)) continue;
      stack.push(...childrenOf(node));
    }
    return output;
  }
  private references(node: PhpNode, reason: string): StatementReference[] {
    return this.descendants(node)
      .filter(
        (item) => (item.kind === 'call' && !this.firstClassCallable(item)) || item.kind === 'new'
      )
      .map((item) => ({
        id: this.id(item, 'reference'),
        label: this.label(item),
        location: this.document.source.span(item),
        reason
      }));
  }
  private opaque(node: PhpNode, reason: string, terminal = false): StatementDescriptor {
    this.diagnostics.add(reason);
    return this.emit(node, 'unsupported', `${reason} ${this.label(node)}`, {
      references: this.references(node, 'Navigation only; execution order is not established'),
      mayThrow: true,
      terminal
    });
  }
  private firstClassCallable(node: PhpNode): boolean {
    return (
      node.kind === 'call' &&
      nodeList(node.arguments).some((arg) => arg.kind === 'variadicplaceholder')
    );
  }
  private effectful(node: PhpNode): boolean {
    if (LITERALS.has(node.kind)) return false;
    if (node.kind === 'variable' && typeof node.name === 'string') return false;
    if (FUNCTION_KINDS.has(node.kind)) return false;
    return true;
  }
  private hasAbrupt(node: PhpNode): boolean {
    return this.descendants(node).some((item) =>
      ['throw', 'exit', 'yield', 'yieldfrom', 'goto'].includes(item.kind)
    );
  }

  private statement(value: unknown): StatementDescriptor[] {
    return this.guard(() => {
      if (Array.isArray(value)) return value.flatMap((item) => this.statement(item));
      const node = asNode(value);
      if (!node) return [];
      if (node.kind === 'block')
        return nodeList(node.children).flatMap((item) => this.statement(item));
      if (node.kind === 'expressionstatement') return this.expression(node.expression, true);
      if (node.kind === 'if') {
        const test = asNode(node.test);
        if (!test) return [this.opaque(node, 'Missing PHP conditional expression.', true)];
        return [
          this.emit(node, 'branch', `If ${this.label(test)}`, {
            condition: this.condition(test),
            children: this.statement(node.body),
            alternate: this.statement(node.alternate)
          })
        ];
      }
      if (['for', 'foreach', 'while', 'do'].includes(node.kind)) return [this.loop(node)];
      if (node.kind === 'switch') return [this.selection(node, false)];
      if (node.kind === 'try') {
        const handlers: CatchDescriptor[] = nodeList(node.catches).map((handler) => {
          const types = nodeList(handler.what).map((type) => nameOf(type) ?? 'unknown');
          const catchesAll = types.some(
            (type) =>
              type.toLowerCase() === '\\throwable' ||
              (this.fn.namespace === '' && type.toLowerCase() === 'throwable')
          );
          return {
            id: this.id(handler, 'catch'),
            label: `Catch ${types.join(' | ')}`,
            location: this.document.source.span(handler),
            body: this.statement(handler.body),
            catchesAll
          };
        });
        const always = asNode(node.always);
        return [
          this.emit(node, 'try', 'Try', {
            children: this.statement(node.body),
            handlers,
            ...(always
              ? {
                  finalizer: {
                    location: this.document.source.span(always),
                    statements: this.statement(always)
                  }
                }
              : {})
          })
        ];
      }
      if (node.kind === 'return') return [...this.expression(node.expr), this.emit(node, 'return')];
      if (node.kind === 'throw' || node.kind === 'exit') return this.expression(node, true);
      if (node.kind === 'break' || node.kind === 'continue') {
        const levelNode = asNode(node.level);
        const level = levelNode?.kind === 'number' ? Number(levelNode.value) : levelNode ? NaN : 1;
        if (!Number.isSafeInteger(level) || level < 1)
          return [this.opaque(node, 'Invalid or nonliteral PHP jump level.', true)];
        return [this.emit(node, node.kind, this.label(node), { jumpLevel: level })];
      }
      if (node.kind === 'goto' || node.kind === 'label')
        return [this.opaque(node, 'Goto control flow is not modeled.', true)];
      if (FUNCTION_KINDS.has(node.kind) || CLASS_KINDS.has(node.kind))
        return [this.emit(node, 'sequence', `Declare ${node.kind} (body is not executed)`)];
      if (node.kind === 'static') {
        return nodeList(node.variables).map((variable) =>
          this.emit(variable, 'branch', 'Static local initialization', {
            condition: this.leaf(variable, 'Static local is initialized'),
            children: [],
            alternate: [
              ...this.expression(variable.defaultValue),
              this.emit(variable, 'sequence', `Initialize ${this.label(variable)}`)
            ]
          })
        );
      }
      if (node.kind === 'echo')
        return nodeList(node.expressions).flatMap((expression) => [
          ...this.expression(expression),
          this.emit(expression, 'sequence', `Echo ${this.label(expression)}`, { mayThrow: true })
        ]);
      if (node.kind === 'global') return [this.emit(node, 'sequence')];
      if (node.kind === 'unset')
        return [
          ...nodeList(node.variables).flatMap((variable) => this.expression(variable)),
          this.emit(node, 'sequence', this.label(node), { mayThrow: true })
        ];
      if (node.kind === 'declare')
        return [
          this.opaque(node, 'Declare directives and implicit tick callbacks are not expanded.'),
          ...this.statement(node.children)
        ];
      if (node.kind === 'noop') return [];
      return [this.opaque(node, `Unsupported PHP statement (${node.kind}).`, true)];
    });
  }

  private loop(node: PhpNode): StatementDescriptor {
    const body = this.statement(node.body);
    if (node.kind === 'foreach') {
      const source = asNode(node.source);
      if (!source) return this.opaque(node, 'Missing foreach source.', true);
      const binding = this.emit(node, 'sequence', 'Bind foreach key/value', { mayThrow: true });
      const test = this.leaf(source, 'Foreach has next item');
      return this.emit(node, 'loop', `Foreach ${this.label(source)}`, {
        initialization: this.expression(source),
        condition: { ...test, mayThrow: true },
        children: [binding, ...body],
        loopMode: 'pretest'
      });
    }
    if (node.kind === 'for') {
      const tests = nodeList(node.test);
      const last = tests.at(-1);
      let condition = last
        ? this.condition(last)
        : this.leaf(node, 'For condition (always true)', [], true);
      const prefix = tests.slice(0, -1).flatMap((item) => this.expression(item, true));
      if (prefix.length) {
        condition = {
          kind: 'and',
          left: this.leaf(node, 'For condition prefix evaluated', prefix, true),
          right: condition
        };
      }
      return this.emit(node, 'loop', 'For', {
        initialization: nodeList(node.init).flatMap((item) => this.expression(item, true)),
        condition,
        update: nodeList(node.increment).flatMap((item) => this.expression(item, true)),
        children: body,
        loopMode: 'pretest'
      });
    }
    const test = asNode(node.test);
    return test
      ? this.emit(
          node,
          'loop',
          `${node.kind === 'do' ? 'Do / while' : 'While'} ${this.label(test)}`,
          {
            condition: this.condition(test),
            children: body,
            loopMode: node.kind === 'do' ? 'posttest' : 'pretest'
          }
        )
      : this.opaque(node, 'Missing loop condition.', true);
  }

  private selection(node: PhpNode, match: boolean): StatementDescriptor {
    const subject = asNode(match ? node.cond : node.test);
    if (!subject) return this.opaque(node, 'Missing selection expression.', true);
    const candidates = match ? nodeList(node.arms) : nodeList(asNode(node.body)?.children);
    const arms: SelectionArm[] = candidates.map((arm) => {
      const tests = match ? nodeList(arm.conds) : nodeList(arm.test);
      return {
        id: this.id(arm, 'arm'),
        label: tests.length
          ? `${match ? 'Match' : 'Case'} ${tests.map((test) => this.label(test)).join(', ')}`
          : 'Default',
        location: this.document.source.span(arm),
        isDefault: tests.length === 0,
        tests: tests.map((test) =>
          this.leaf(
            test,
            `Selected value ${match ? '===' : '=='} ${this.label(test)}`,
            this.expression(test)
          )
        ),
        body: match
          ? [
              ...this.expression(arm.body),
              this.emit(
                arm,
                'sequence',
                `Match result: ${asNode(arm.body) ? this.label(asNode(arm.body)!) : 'unknown'}`
              )
            ]
          : this.statement(arm.body)
      };
    });
    return this.emit(node, 'selection', `${match ? 'Match' : 'Switch'} ${this.label(subject)}`, {
      initialization: this.expression(subject),
      selection: {
        arms,
        fallthrough: !match,
        breakable: !match,
        countForContinue: !match,
        unmatched: match ? 'throw' : 'normal'
      }
    });
  }

  private condition(node: PhpNode): ConditionDescriptor {
    return this.guard(() => {
      if (node.kind === 'bin') {
        const left = asNode(node.left),
          right = asNode(node.right);
        if (
          left &&
          right &&
          (SHORT_AND.has(String(node.type)) || SHORT_OR.has(String(node.type)))
        ) {
          return {
            kind: SHORT_AND.has(String(node.type)) ? 'and' : 'or',
            left: this.condition(left),
            right: this.condition(right)
          };
        }
        if (left && right && node.type === '??') {
          return {
            kind: 'choice',
            test: this.present(left),
            whenTrue: this.leaf(
              left,
              `Truthiness of cached value: ${this.label(left)}`,
              [],
              this.bool(left)
            ),
            whenFalse: this.condition(right)
          };
        }
      }
      if (node.kind === 'unary' && node.type === '!' && asNode(node.what))
        return { kind: 'not', operand: this.condition(asNode(node.what)!) };
      if (node.kind === 'retif') {
        const test = asNode(node.test),
          yes = asNode(node.trueExpr),
          no = asNode(node.falseExpr);
        if (test && no)
          return yes
            ? {
                kind: 'choice',
                test: this.condition(test),
                whenTrue: this.condition(yes),
                whenFalse: this.condition(no)
              }
            : { kind: 'or', left: this.condition(test), right: this.condition(no) };
      }
      if (
        node.kind === 'assign' &&
        node.operator === '=' &&
        asNode(node.left)?.kind === 'variable' &&
        asNode(node.right)
      ) {
        return {
          kind: 'choice',
          test: this.condition(asNode(node.right)!),
          whenTrue: this.leaf(
            node,
            'Assigned value is truthy',
            [this.emit(node, 'sequence')],
            true
          ),
          whenFalse: this.leaf(
            node,
            'Assigned value is falsy',
            [this.emit(node, 'sequence')],
            false
          )
        };
      }
      if (node.kind === 'isset') {
        const tests = nodeList(node.variables).map((variable) => this.present(variable));
        return (
          tests.reduce<ConditionDescriptor | undefined>(
            (all, test) => (all ? { kind: 'and', left: all, right: test } : test),
            undefined
          ) ?? this.leaf(node, 'Isset', [], false)
        );
      }
      const chain = this.chain(node);
      if (chain?.steps.some((step) => step.lookup.kind === 'nullsafepropertylookup')) {
        return this.chainCondition(chain, node);
      }
      return this.leaf(node, this.label(node), this.expression(node), this.bool(node));
    });
  }

  private expression(value: unknown, render = false): StatementDescriptor[] {
    return this.guard(() => {
      const node = asNode(value);
      if (!node) return [];
      if (FUNCTION_KINDS.has(node.kind) || CLASS_KINDS.has(node.kind))
        return render
          ? [this.emit(node, 'sequence', `Declare ${node.kind} (body is not executed)`)]
          : [];
      if (LITERALS.has(node.kind)) return render ? [this.emit(node, 'sequence')] : [];
      if (node.kind === 'variable') {
        if (typeof node.name === 'string') return render ? [this.emit(node, 'sequence')] : [];
        return [
          ...this.expression(node.name),
          this.emit(node, 'sequence', 'Dynamic variable lookup', { mayThrow: true })
        ];
      }
      if (node.kind === 'throw') return [...this.expression(node.what), this.emit(node, 'throw')];
      if (node.kind === 'exit')
        return [
          ...this.expression(node.expression),
          this.emit(node, 'exit', node.useDie ? 'Die' : 'Exit')
        ];
      if (node.kind === 'match') return [this.selection(node, true)];
      if (node.kind === 'bin') {
        const left = asNode(node.left),
          right = asNode(node.right);
        if (!left || !right) return [this.opaque(node, 'Missing binary operands.', true)];
        if (SHORT_AND.has(String(node.type)) || SHORT_OR.has(String(node.type)))
          return [
            this.emit(node, 'branch', 'Short-circuit expression', {
              condition: this.condition(node),
              children: [],
              alternate: []
            })
          ];
        if (node.type === '??')
          return [
            this.emit(node, 'branch', 'Null coalescing', {
              condition: this.present(left),
              children: [],
              alternate: this.expression(right, render)
            })
          ];
        if (this.effectful(left) && this.effectful(right))
          return [
            this.opaque(node, 'Operand evaluation order is not established.', this.hasAbrupt(node))
          ];
        // A mutation and a read of a variable must not be assigned a fictitious order.
        const mutable = this.descendants(node).some((item) =>
          ['pre', 'post', 'assign'].includes(item.kind)
        );
        if (mutable && !LITERALS.has(left.kind) && !LITERALS.has(right.kind))
          return [
            this.opaque(node, 'Operand evaluation order is not established.', this.hasAbrupt(node))
          ];
        return [
          ...this.expression(left),
          ...this.expression(right),
          this.emit(node, 'sequence', this.label(node), {
            mayThrow: !['===', '!==', 'instanceof'].includes(String(node.type))
          })
        ];
      }
      if (node.kind === 'retif') {
        const test = asNode(node.test);
        if (!test) return [this.opaque(node, 'Missing ternary test.', true)];
        return [
          this.emit(node, 'branch', 'Conditional expression', {
            condition: this.condition(test),
            children: this.expression(node.trueExpr, render),
            alternate: this.expression(node.falseExpr, render)
          })
        ];
      }
      if (node.kind === 'assign') {
        const left = asNode(node.left),
          right = asNode(node.right);
        if (!left || !right) return [this.opaque(node, 'Unsupported assignment shape.', true)];
        if (node.operator === '??=') {
          if (left.kind !== 'variable' || typeof left.name !== 'string')
            return [
              this.opaque(
                node,
                'Complex coalescing assignment is not expanded.',
                this.hasAbrupt(node)
              )
            ];
          return [
            this.emit(node, 'branch', 'Null coalescing assignment', {
              condition: this.present(left),
              children: [],
              alternate: [...this.expression(right), this.emit(node, 'sequence')]
            })
          ];
        }
        if (left.kind !== 'variable' || typeof left.name !== 'string') {
          const receiver = asNode(left.what);
          const key = asNode(left.offset);
          const simpleAddress =
            ['propertylookup', 'staticlookup', 'offsetlookup'].includes(left.kind) &&
            receiver?.kind === 'variable' &&
            typeof receiver.name === 'string' &&
            (!key || LITERALS.has(key.kind));
          // An address without executable subexpressions needs no synthetic getter read.
          // Dynamic keys / nested receivers remain opaque when their order matters.
          if (simpleAddress)
            return [
              ...this.expression(right),
              this.emit(node, 'sequence', this.label(node), { mayThrow: true })
            ];
          return [
            this.opaque(
              node,
              'Complex assignment target order is not expanded.',
              this.hasAbrupt(node)
            )
          ];
        }
        return [
          ...this.expression(right),
          this.emit(node, 'sequence', this.label(node), { mayThrow: node.operator !== '=' })
        ];
      }
      if (['pre', 'post'].includes(node.kind))
        return [
          ...this.expression(node.what),
          this.emit(node, 'sequence', this.label(node), { mayThrow: true })
        ];
      if (
        [
          'unary',
          'cast',
          'silent',
          'clone',
          'print',
          'empty',
          'variadic',
          'namedargument',
          'encapsedpart'
        ].includes(node.kind)
      ) {
        const nested = node.what ?? node.expr ?? node.expression ?? node.value;
        const output = this.expression(nested);
        return ['variadic', 'namedargument', 'encapsedpart'].includes(node.kind)
          ? output
          : [
              ...output,
              this.emit(node, 'sequence', this.label(node), {
                mayThrow: node.kind !== 'silent' && node.kind !== 'empty'
              })
            ];
      }
      if (node.kind === 'isset')
        return [
          this.emit(node, 'branch', 'Isset short-circuit', {
            condition: this.condition(node),
            children: [],
            alternate: []
          })
        ];
      if (node.kind === 'array' || node.kind === 'encapsed') {
        if (
          this.descendants(node).some((item) =>
            ['call', 'new', 'throw', 'exit', 'pre', 'post', 'assign'].includes(item.kind)
          )
        ) {
          return [
            this.opaque(
              node,
              'Compound value element evaluation is not expanded.',
              this.hasAbrupt(node)
            )
          ];
        }
        return render ? [this.emit(node, 'sequence')] : [];
      }
      if (node.kind === 'include' || node.kind === 'eval')
        return [
          ...this.expression(node.target ?? node.source),
          this.opaque(node, 'Dynamic code loading/execution is not expanded.', true)
        ];
      const chain = this.chain(node);
      if (chain) return [...this.expression(chain.base), ...this.chainSteps(chain.steps, 0)];
      if (node.kind === 'call' || node.kind === 'new') {
        const callee = asNode(node.what);
        if (this.firstClassCallable(node))
          return [
            ...this.expression(node.what),
            this.emit(node, 'sequence', 'Create first-class callable (not invoked)', {
              mayThrow: true
            })
          ];
        if (
          callee &&
          this.chain(callee)?.steps.some((step) => step.lookup.kind === 'nullsafepropertylookup')
        )
          return [this.opaque(node, 'Nullable callable invocation is not expanded.', true)];
        return [
          ...this.expression(node.what),
          ...this.arguments(node),
          this.emit(node, 'call', this.label(node), { mayThrow: true })
        ];
      }
      return [
        this.opaque(node, `Unsupported PHP expression (${node.kind}).`, this.hasAbrupt(node))
      ];
    });
  }

  /** Arguments have their own sub-chains and are evaluated left-to-right. */
  private arguments(node: PhpNode): StatementDescriptor[] {
    return nodeList(node.arguments).flatMap((argument) => this.expression(argument));
  }
  private chain(node: PhpNode): Chain | undefined {
    const steps: ChainStep[] = [];
    let current = node;
    while (true) {
      const callee = current.kind === 'call' ? asNode(current.what) : undefined;
      const lookup =
        callee && LOOKUPS.has(callee.kind)
          ? callee
          : LOOKUPS.has(current.kind)
            ? current
            : undefined;
      const receiver = lookup ? asNode(lookup.what) : undefined;
      if (!lookup || !receiver) break;
      steps.unshift({ node: current, lookup });
      current = receiver;
    }
    return steps.length ? { base: current, steps } : undefined;
  }
  private stepEffects(step: ChainStep): StatementDescriptor[] {
    const offset = asNode(step.lookup.offset);
    const nameEffects =
      offset && !['identifier', 'name', 'string', 'number'].includes(offset.kind)
        ? this.expression(offset)
        : [];
    if (this.firstClassCallable(step.node))
      return [
        ...nameEffects,
        this.emit(step.node, 'sequence', 'Create first-class callable (not invoked)', {
          mayThrow: true
        })
      ];
    return step.node.kind === 'call'
      ? [
          ...nameEffects,
          ...this.arguments(step.node),
          this.emit(step.node, 'call', this.label(step.node), { mayThrow: true })
        ]
      : [
          ...nameEffects,
          this.emit(step.node, 'sequence', this.label(step.node), { mayThrow: true })
        ];
  }
  private nullsafeGuard(
    lookup: PhpNode,
    evaluation: readonly StatementDescriptor[] = []
  ): ConditionDescriptor {
    const receiver = asNode(lookup.what)!;
    return this.leaf(
      lookup,
      `Receiver is not null: ${this.label(receiver)}`,
      evaluation,
      receiver.kind === 'nullkeyword' ? false : undefined
    );
  }
  private chainSteps(steps: readonly ChainStep[], index: number): StatementDescriptor[] {
    return this.guard(() => {
      const step = steps[index];
      if (!step) return [];
      const effects = this.stepEffects(step);
      const rest = this.chainSteps(steps, index + 1);
      return step.lookup.kind === 'nullsafepropertylookup'
        ? [
            this.emit(step.lookup, 'branch', 'Nullsafe chain', {
              condition: this.nullsafeGuard(step.lookup),
              children: [...effects, ...rest],
              alternate: []
            })
          ]
        : [...effects, ...rest];
    });
  }
  private chainCondition(chain: Chain, node: PhpNode): ConditionDescriptor {
    const descend = (index: number, prefix: readonly StatementDescriptor[]): ConditionDescriptor =>
      this.guard(() => {
        const step = chain.steps[index];
        if (!step)
          return this.leaf(node, `Truthiness of chain result: ${this.label(node)}`, prefix);
        const effects = this.stepEffects(step);
        if (step.lookup.kind === 'nullsafepropertylookup')
          return {
            kind: 'choice',
            test: this.nullsafeGuard(step.lookup, prefix),
            whenTrue: descend(index + 1, effects),
            whenFalse: this.leaf(step.lookup, 'Nullsafe result is null', [], false)
          };
        return descend(index + 1, [...prefix, ...effects]);
      });
    return descend(0, this.expression(chain.base));
  }
}
