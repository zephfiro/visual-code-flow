import type {
  AnalysisResult,
  Cancellation,
  ConditionDescriptor,
  SourceSpan,
  StatementDescriptor
} from '@visual-code-flow/shared';
import {
  FLOW_SCHEMA_VERSION,
  type FlowDiagnostic,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind
} from './model.js';
import { assertValidFlowGraph } from './validation.js';

interface PendingEdge {
  readonly source: string;
  readonly kind: FlowEdgeKind;
  readonly label?: string;
}
type CompletionKind = 'normal' | 'return' | 'throw' | 'exit' | 'break' | 'continue';
interface Completion {
  readonly kind: CompletionKind;
  readonly level: number;
  readonly edge: PendingEdge;
}
interface ConditionResult {
  readonly yes: readonly PendingEdge[];
  readonly no: readonly PendingEdge[];
  readonly abrupt: readonly Completion[];
}
export interface FlowBuildOptions {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxDepth?: number;
  readonly cancellation?: Cancellation;
}
export class FlowBuildError extends Error {
  constructor(readonly code: 'limit' | 'cancelled' | 'invalid-statement') {
    super(
      code === 'limit'
        ? 'Flow graph exceeded its configured complexity limit.'
        : code === 'cancelled'
          ? 'Flow construction was cancelled.'
          : 'Invalid structured flow statement.'
    );
    this.name = 'FlowBuildError';
  }
}
const pending = (source: string, kind: FlowEdgeKind = 'normal', label?: string): PendingEdge => ({
  source,
  kind,
  ...(label ? { label } : {})
});
const completion = (edge: PendingEdge, kind: CompletionKind = 'normal', level = 0): Completion => ({
  edge,
  kind,
  level
});
const split = (items: readonly Completion[]) => ({
  normal: items.filter((item) => item.kind === 'normal').map((item) => item.edge),
  abrupt: items.filter((item) => item.kind !== 'normal')
});
const scoped = (id: string, scope: string): string => (scope ? `${id}@${scope}` : id);

/**
 * Structured CFG assembly with explicit pending completions. Finalizers are
 * cloned per continuation category so a return can never resume a normal path.
 * Reference edges are navigation only and are not part of the execution CFG.
 */
export function buildControlFlowGraph(
  result: AnalysisResult,
  options: FlowBuildOptions = {}
): FlowGraph {
  const maxNodes = options.maxNodes ?? 5_000;
  const maxEdges = options.maxEdges ?? 20_000;
  const maxDepth = options.maxDepth ?? 128;
  for (const value of [maxNodes, maxEdges, maxDepth]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new FlowBuildError('limit');
  }
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const diagnostics: FlowDiagnostic[] = result.diagnostics.map((message, index) => ({
    code: `analyzer-${index}`,
    message,
    severity: 'warning'
  }));
  const entryId = `${result.function.symbolId}:entry`;
  const exitId = `${result.function.symbolId}:exit`;
  const nodeIds = new Set<string>();
  let edgeNumber = 0;
  let cloneNumber = 0;
  let depth = 0;

  function check(): void {
    if (options.cancellation?.isCancellationRequested) throw new FlowBuildError('cancelled');
  }
  function guarded<T>(work: () => T): T {
    check();
    if (++depth > maxDepth) throw new FlowBuildError('limit');
    try {
      return work();
    } finally {
      depth--;
    }
  }
  function addNode(id: string, kind: FlowNodeKind, label: string, source?: SourceSpan): void {
    check();
    if (nodes.length >= maxNodes) throw new FlowBuildError('limit');
    if (nodeIds.has(id)) throw new FlowBuildError('invalid-statement');
    nodeIds.add(id);
    nodes.push({
      id,
      kind,
      label: label || kind,
      expandable: false,
      ...(source ? { source } : {})
    });
  }
  function connect(from: readonly PendingEdge[], target: string): void {
    for (const edge of from) {
      check();
      if (edges.length >= maxEdges) throw new FlowBuildError('limit');
      edges.push({
        id: `edge-${++edgeNumber}`,
        source: edge.source,
        target,
        kind: edge.kind,
        ...(edge.label ? { label: edge.label } : {})
      });
    }
  }
  function join(id: string, values: readonly Completion[]): Completion[] {
    const parts = split(values);
    if (parts.normal.length <= 1) return [...values];
    addNode(id, 'merge', 'Merge');
    connect(parts.normal, id);
    return [...parts.abrupt, completion(pending(id))];
  }
  function thrown(id: string, label = 'may throw'): Completion {
    return completion(pending(id, 'exception', label), 'throw');
  }

  function condition(
    value: ConditionDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): ConditionResult {
    return guarded(() => {
      if (!incoming.length) return { yes: [], no: [], abrupt: [] };
      if (value.kind === 'and' || value.kind === 'or') {
        const left = condition(value.left, incoming, scope);
        const right = condition(value.right, value.kind === 'and' ? left.yes : left.no, scope);
        return {
          yes: value.kind === 'and' ? right.yes : [...left.yes, ...right.yes],
          no: value.kind === 'and' ? [...left.no, ...right.no] : right.no,
          abrupt: [...left.abrupt, ...right.abrupt]
        };
      }
      if (value.kind === 'not') {
        const operand = condition(value.operand, incoming, scope);
        return { yes: operand.no, no: operand.yes, abrupt: operand.abrupt };
      }
      if (value.kind === 'choice') {
        const test = condition(value.test, incoming, scope);
        const yes = condition(value.whenTrue, test.yes, scope);
        const no = condition(value.whenFalse, test.no, scope);
        return {
          yes: [...yes.yes, ...no.yes],
          no: [...yes.no, ...no.no],
          abrupt: [...test.abrupt, ...yes.abrupt, ...no.abrupt]
        };
      }
      if (value.kind !== 'test') throw new FlowBuildError('invalid-statement');
      const evaluated = split(sequence(value.evaluation ?? [], incoming, scope));
      if (!evaluated.normal.length) return { yes: [], no: [], abrupt: evaluated.abrupt };
      const id = scoped(value.id, scope);
      addNode(id, 'condition', value.label, value.location);
      connect(evaluated.normal, id);
      return {
        yes: value.constant === false ? [] : [pending(id, 'true')],
        no: value.constant === true ? [] : [pending(id, 'false')],
        abrupt: [...evaluated.abrupt, ...(value.mayThrow ? [thrown(id)] : [])]
      };
    });
  }

  function sequence(
    statements: readonly StatementDescriptor[],
    incoming: readonly PendingEdge[],
    scope = ''
  ): Completion[] {
    return guarded(() => {
      let current = [...incoming];
      const abrupt: Completion[] = [];
      for (const statement of statements) {
        if (!current.length) break;
        const output = split(visit(statement, current, scope));
        abrupt.push(...output.abrupt);
        current = output.normal;
      }
      return [...abrupt, ...current.map((edge) => completion(edge))];
    });
  }

  function branch(
    statement: StatementDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): Completion[] {
    const test = condition(
      statement.condition ?? {
        kind: 'test',
        id: statement.id,
        label: statement.label,
        location: statement.location
      },
      incoming,
      scope
    );
    return join(scoped(`${statement.id}:merge`, scope), [
      ...test.abrupt,
      ...sequence(statement.children ?? [], test.yes, scope),
      ...sequence(statement.alternate ?? [], test.no, scope)
    ]);
  }

  function loop(
    statement: StatementDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): Completion[] {
    const initialized = split(sequence(statement.initialization ?? [], incoming, scope));
    if (!initialized.normal.length) return initialized.abrupt;
    const id = scoped(statement.id, scope);
    const post = statement.loopMode === 'posttest';
    const header = post ? `${id}:test` : id;
    const output: Completion[] = [...initialized.abrupt];
    addNode(id, 'loop', post ? 'Do body' : statement.label, statement.location);
    connect(initialized.normal, id);
    let test: ConditionResult = { yes: [pending(id)], no: [], abrupt: [] };
    if (!post) {
      test = statement.condition
        ? condition(statement.condition, [pending(id)], scope)
        : { yes: [pending(id, 'true')], no: [pending(id, 'false')], abrupt: [] };
      output.push(...test.abrupt);
    }
    const body = sequence(statement.children ?? [], test.yes, scope);
    const advance: PendingEdge[] = [];
    for (const item of body) {
      if (item.kind === 'normal') advance.push(item.edge);
      else if (item.kind === 'break' && item.level === 1) output.push(completion(item.edge));
      else if (item.kind === 'continue' && item.level === 1) advance.push(item.edge);
      else if (item.kind === 'break' || item.kind === 'continue') {
        output.push({ ...item, level: item.level - 1 });
      } else output.push(item);
    }
    const updated = split(sequence(statement.update ?? [], advance, scope));
    output.push(...updated.abrupt);
    if (post) {
      if (updated.normal.length) {
        addNode(header, 'loop', statement.label, statement.location);
        connect(updated.normal, header);
        test = statement.condition
          ? condition(statement.condition, [pending(header)], scope)
          : { yes: [pending(header, 'true')], no: [pending(header, 'false')], abrupt: [] };
        output.push(...test.abrupt);
        connect(
          test.yes.map((edge) => pending(edge.source, 'loop-back', 'true')),
          id
        );
        output.push(...test.no.map((edge) => completion(edge)));
      }
    } else {
      connect(
        updated.normal.map((edge) =>
          edge.kind === 'continue' ? edge : pending(edge.source, 'loop-back', edge.label)
        ),
        header
      );
      output.push(...test.no.map((edge) => completion(edge)));
    }
    return output;
  }

  function selection(
    statement: StatementDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): Completion[] {
    const spec = statement.selection;
    if (
      !spec ||
      spec.arms.filter((arm) => arm.isDefault).length > 1 ||
      spec.arms.some((arm) => !arm.isDefault && !arm.tests.length)
    )
      throw new FlowBuildError('invalid-statement');
    const initialized = split(sequence(statement.initialization ?? [], incoming, scope));
    if (!initialized.normal.length) return initialized.abrupt;
    const id = scoped(statement.id, scope);
    addNode(id, 'condition', statement.label, statement.location);
    connect(initialized.normal, id);
    const output: Completion[] = [...initialized.abrupt];
    const entries = new Map<string, PendingEdge[]>();
    let unmatched: readonly PendingEdge[] = [pending(id)];
    for (const arm of spec.arms) {
      if (arm.isDefault) continue;
      const entry: PendingEdge[] = [];
      for (const value of arm.tests) {
        const test = condition(value, unmatched, scope);
        entry.push(...test.yes);
        unmatched = test.no;
        output.push(...test.abrupt);
      }
      entries.set(arm.id, entry);
    }
    const defaultArm = spec.arms.find((arm) => arm.isDefault);
    if (defaultArm) entries.set(defaultArm.id, [...unmatched]);
    else if (spec.unmatched === 'throw' && unmatched.length) {
      const failure = `${id}:unmatched`;
      addNode(failure, 'throw', 'Unhandled match', statement.location);
      connect(unmatched, failure);
      output.push(thrown(failure, 'unmatched selection'));
    } else output.push(...unmatched.map((edge) => completion(edge)));
    let falling: PendingEdge[] = [];
    for (const arm of spec.arms) {
      const entry = [...(entries.get(arm.id) ?? []), ...falling];
      falling = [];
      if (!entry.length) continue;
      const armId = scoped(`${arm.id}:body`, scope);
      addNode(armId, 'operation', arm.label, arm.location);
      connect(entry, armId);
      for (const item of sequence(arm.body, [pending(armId)], scope)) {
        if (item.kind === 'normal') {
          if (spec.fallthrough) falling.push(item.edge);
          else output.push(item);
        } else if (
          (item.kind === 'break' && spec.breakable) ||
          (item.kind === 'continue' && spec.countForContinue)
        ) {
          if (item.level === 1) {
            output.push(completion(item.edge));
            if (item.kind === 'continue')
              diagnostics.push({
                code: `switch-continue-${armId}`,
                message: 'A continue targeting this selection behaves as a break.',
                severity: 'warning',
                source: arm.location
              });
          } else output.push({ ...item, level: item.level - 1 });
        } else output.push(item);
      }
    }
    output.push(...falling.map((edge) => completion(edge)));
    return join(`${id}:merge`, output);
  }

  function withFinalizer(
    statement: StatementDescriptor,
    values: readonly Completion[],
    scope: string
  ): Completion[] {
    const finalizer = statement.finalizer;
    if (!finalizer) return [...values];
    // Abrupt script termination does not run a pending finalizer.
    const output = values.filter((item) => item.kind === 'exit');
    const groups = new Map<string, Completion[]>();
    const order: readonly CompletionKind[] = ['normal', 'return', 'throw', 'break', 'continue'];
    for (const kind of order) {
      for (const item of values.filter((value) => value.kind === kind)) {
        const key = `${kind}:${item.level}`;
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
    }
    for (const [key, group] of groups) {
      const previous = group[0]!;
      const marker = scoped(`${statement.id}:finally:${key}`, scope);
      addNode(
        marker,
        'operation',
        `finally (${previous.kind}${previous.level ? ` ${previous.level}` : ''})`,
        finalizer.location
      );
      connect(
        group.map((item) => item.edge),
        marker
      );
      const cloneScope = `${scope ? `${scope}/` : ''}finally-${++cloneNumber}`;
      for (const item of sequence(finalizer.statements, [pending(marker)], cloneScope)) {
        if (item.kind !== 'normal') output.push(item);
        else {
          const kind: FlowEdgeKind =
            previous.kind === 'throw'
              ? 'exception'
              : previous.kind === 'break' || previous.kind === 'continue'
                ? previous.kind
                : item.edge.kind;
          output.push(
            completion(
              pending(
                item.edge.source,
                kind,
                previous.kind === 'normal' ? item.edge.label : `resume ${previous.kind}`
              ),
              previous.kind,
              previous.level
            )
          );
        }
      }
    }
    if (groups.size > 1)
      diagnostics.push({
        code: `finally-paths-${scoped(statement.id, scope)}`,
        message:
          'Finally is shown separately for pending completions; these are alternative paths, not repeated execution.',
        severity: 'info',
        source: finalizer.location
      });
    return output;
  }

  function tryStatement(
    statement: StatementDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): Completion[] {
    const id = scoped(statement.id, scope);
    addNode(id, 'operation', 'try', statement.location);
    connect(incoming, id);
    const body = sequence(statement.children ?? [], [pending(id)], scope);
    const output = body.filter((item) => item.kind !== 'throw');
    let remaining = body.filter((item) => item.kind === 'throw').map((item) => item.edge);
    for (const handler of statement.handlers ?? []) {
      if (!remaining.length) break;
      const handlerId = scoped(handler.id, scope);
      addNode(handlerId, 'condition', handler.label, handler.location);
      connect(remaining, handlerId);
      output.push(...sequence(handler.body, [pending(handlerId, 'true', 'matches')], scope));
      remaining = handler.catchesAll ? [] : [pending(handlerId, 'false', 'not matched')];
    }
    output.push(...remaining.map((edge) => completion(edge, 'throw')));
    return withFinalizer(statement, output, scope);
  }

  function visit(
    statement: StatementDescriptor,
    incoming: readonly PendingEdge[],
    scope: string
  ): Completion[] {
    check();
    if (statement.kind === 'branch') return branch(statement, incoming, scope);
    if (statement.kind === 'loop') return loop(statement, incoming, scope);
    if (statement.kind === 'selection') return selection(statement, incoming, scope);
    if (statement.kind === 'try') return tryStatement(statement, incoming, scope);
    const id = scoped(statement.id, scope);
    const kind: FlowNodeKind =
      statement.kind === 'sequence' || statement.kind === 'break' || statement.kind === 'continue'
        ? 'operation'
        : statement.kind;
    addNode(id, kind, statement.label, statement.location);
    connect(incoming, id);
    for (const reference of statement.references ?? []) {
      const referenceId = scoped(reference.id, scope);
      addNode(referenceId, 'call', reference.label, reference.location);
      connect([pending(id, 'reference', reference.reason)], referenceId);
    }
    const output: Completion[] = statement.mayThrow ? [thrown(id)] : [];
    if (statement.kind === 'return') output.push(completion(pending(id), 'return'));
    else if (statement.kind === 'throw') output.push(thrown(id, 'throw'));
    else if (statement.kind === 'exit')
      output.push(completion(pending(id, 'normal', 'terminate'), 'exit'));
    else if (statement.kind === 'break' || statement.kind === 'continue') {
      const level = statement.jumpLevel ?? 1;
      if (!Number.isSafeInteger(level) || level < 1) throw new FlowBuildError('invalid-statement');
      output.push(completion(pending(id, statement.kind), statement.kind, level));
    } else {
      if (statement.kind === 'unsupported')
        diagnostics.push({
          code: `unsupported-${id}`,
          message: `Opaque or unsupported control-flow construct: ${statement.label}`,
          severity: 'warning',
          source: statement.location
        });
      if (!statement.terminal) output.push(completion(pending(id)));
    }
    return output;
  }

  addNode(entryId, 'entry', result.function.name);
  addNode(exitId, 'exit', 'Exit');
  for (const item of sequence(result.statements, [pending(entryId)])) {
    if (item.kind === 'break' || item.kind === 'continue') {
      diagnostics.push({
        code: `unbound-jump-${item.edge.source}`,
        message:
          'A jump has no matching enclosing control target; normal continuation is not assumed.',
        severity: 'error'
      });
      connect([pending(item.edge.source, 'exception', 'invalid jump target')], exitId);
    } else
      connect(
        [
          item.kind === 'throw'
            ? pending(item.edge.source, 'exception', item.edge.label)
            : item.edge
        ],
        exitId
      );
  }
  const graph: FlowGraph = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    rootSymbolId: result.function.symbolId,
    nodes,
    edges,
    diagnostics
  };
  assertValidFlowGraph(graph);
  return graph;
}
