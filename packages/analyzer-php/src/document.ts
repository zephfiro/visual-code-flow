import { Engine } from 'php-parser';
import type {
  AnalysisRequest,
  Cancellation,
  FunctionDescriptor,
  SourceSpan
} from '@visual-code-flow/shared';
import { asNode, childrenOf, nameOf, CLASS_KINDS, FUNCTION_KINDS, type PhpNode } from './ast.js';
import { PhpSource } from './source.js';

export type PhpErrorCode =
  'invalid-syntax' | 'analysis-limit' | 'unsupported-document' | 'cancelled' | 'stale-symbol';
const MESSAGES: Readonly<Record<PhpErrorCode, string>> = {
  'invalid-syntax':
    'PHP syntax is incomplete or unsupported. The previous valid graph is unchanged.',
  'analysis-limit': 'PHP analysis exceeded a configured source or AST limit.',
  'unsupported-document': 'This document is not supported as a plain PHP source file.',
  cancelled: 'PHP analysis was cancelled.',
  'stale-symbol': 'The selected PHP function no longer matches this source snapshot.'
};

/** Never expose a parser error/cause: it may contain source fragments or secrets. */
export class PhpAnalysisError extends Error {
  constructor(readonly code: PhpErrorCode) {
    super(MESSAGES[code]);
    this.name = 'PhpAnalysisError';
  }
}

export function checkCancellation(cancellation?: Cancellation): void {
  if (cancellation?.isCancellationRequested) throw new PhpAnalysisError('cancelled');
}

export interface PhpParserLimits {
  readonly maxSourceLength: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxCacheEntries: number;
}
const DEFAULT_LIMITS: PhpParserLimits = Object.freeze({
  maxSourceLength: 256_000,
  maxNodes: 40_000,
  maxDepth: 256,
  maxCacheEntries: 8
});

export interface PhpFunctionRecord {
  readonly descriptor: FunctionDescriptor;
  readonly node: PhpNode;
  readonly body: PhpNode;
  readonly definition: SourceSpan;
  readonly start: number;
  readonly end: number;
  readonly namespace: string;
  readonly owner: PhpNode | undefined;
  readonly ownerName: string | undefined;
  readonly enclosingSymbolId: string | undefined;
}

interface Context {
  readonly namespace: string;
  readonly owner: PhpNode | undefined;
  readonly ownerName: string | undefined;
  readonly enclosingSymbolId: string | undefined;
}
interface Frame extends Context {
  readonly node: PhpNode;
  readonly parent: PhpNode | undefined;
  readonly depth: number;
}
function qualify(namespace: string, name: string): string {
  return namespace ? `${namespace}\\${name}` : name;
}

export class PhpDocument {
  readonly request: AnalysisRequest;
  readonly source: PhpSource;
  readonly nodes: readonly PhpNode[];
  readonly functions: readonly PhpFunctionRecord[];
  private readonly parents = new WeakMap<PhpNode, PhpNode>();

  constructor(
    request: AnalysisRequest,
    readonly ast: PhpNode,
    limits: PhpParserLimits,
    cancellation?: Cancellation
  ) {
    this.request = Object.freeze({ ...request });
    this.source = new PhpSource(request.uri, request.text);
    const nodes: PhpNode[] = [];
    const functions: PhpFunctionRecord[] = [];
    const stack: Frame[] = [
      {
        node: ast,
        parent: undefined,
        depth: 0,
        namespace: '',
        owner: undefined,
        ownerName: undefined,
        enclosingSymbolId: undefined
      }
    ];
    while (stack.length) {
      checkCancellation(cancellation);
      const frame = stack.pop()!;
      if (frame.depth > limits.maxDepth || nodes.length >= limits.maxNodes) {
        throw new PhpAnalysisError('analysis-limit');
      }
      const { node, parent } = frame;
      nodes.push(node);
      if (parent) this.parents.set(node, parent);
      let context: Context = frame;
      if (node.kind === 'namespace') {
        context = { ...context, namespace: nameOf(node.name) ?? '' };
      } else if (CLASS_KINDS.has(node.kind)) {
        const className = nameOf(node.name) ?? `<anonymous:${this.source.offsets(node)[0]}>`;
        context = {
          ...context,
          owner: node,
          ownerName: qualify(context.namespace, className),
          enclosingSymbolId: undefined
        };
      }
      const body = asNode(node.body);
      if (FUNCTION_KINDS.has(node.kind) && body) {
        if (node.kind === 'function') {
          context = { ...context, owner: undefined, ownerName: undefined };
        }
        const [start, end] = this.source.offsets(node);
        const binding =
          parent?.kind === 'assign' && parent.right === node ? asNode(parent.left) : undefined;
        const nameNode = asNode(node.name);
        const shortName = nameOf(node.name);
        const displayName = shortName
          ? node.kind === 'method' && context.ownerName
            ? `${context.ownerName}::${shortName}`
            : qualify(context.namespace, shortName)
          : binding?.kind === 'variable' && nameOf(binding.name)
            ? `$${nameOf(binding.name)}`
            : `<${node.kind}:${this.source.positionAt(start).line + 1}>`;
        const descriptor: FunctionDescriptor = Object.freeze({
          symbolId: `${request.uri}#php:${start}:${displayName}`,
          name: displayName,
          location: this.source.span(node),
          body: this.source.span(body),
          languageId: 'php'
        });
        const definitionNode = nameNode ?? binding ?? node;
        functions.push(
          Object.freeze({
            descriptor,
            node,
            body,
            start,
            end,
            definition: this.source.span(definitionNode),
            namespace: context.namespace,
            owner: context.owner,
            ownerName: context.ownerName,
            enclosingSymbolId: context.enclosingSymbolId
          })
        );
        context = { ...context, enclosingSymbolId: descriptor.symbolId };
      }
      for (const child of [...childrenOf(node)].reverse()) {
        stack.push({ ...context, node: child, parent: node, depth: frame.depth + 1 });
      }
    }
    this.nodes = Object.freeze(nodes);
    this.functions = Object.freeze(functions);
  }

  parentOf(node: PhpNode): PhpNode | undefined {
    return this.parents.get(node);
  }
}

/** Bounded LRU; a matching URI/version is insufficient when editor text changed. */
export class PhpDocumentCache {
  readonly limits: PhpParserLimits;
  private readonly documents = new Map<string, PhpDocument>();

  constructor(limits: Partial<PhpParserLimits> = {}) {
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    const caps: PhpParserLimits = {
      maxSourceLength: 1_000_000,
      maxNodes: 100_000,
      maxDepth: 512,
      maxCacheEntries: 16
    };
    for (const key of Object.keys(caps) as (keyof PhpParserLimits)[]) {
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > caps[key]
      )
        throw new RangeError(`Invalid PHP analysis limit: ${key}`);
    }
  }

  get size(): number {
    return this.documents.size;
  }

  get(request: AnalysisRequest, cancellation?: Cancellation): PhpDocument {
    checkCancellation(cancellation);
    let blade = false;
    try {
      blade = new URL(request.uri).pathname.toLowerCase().endsWith('.blade.php');
    } catch {
      blade = request.uri.toLowerCase().endsWith('.blade.php');
    }
    if (request.languageId !== 'php' || !request.uri || blade) {
      throw new PhpAnalysisError('unsupported-document');
    }
    if (request.text.length > this.limits.maxSourceLength)
      throw new PhpAnalysisError('analysis-limit');
    const previous = this.documents.get(request.uri);
    if (
      previous?.request.documentVersion === request.documentVersion &&
      previous.request.text === request.text
    ) {
      this.documents.delete(request.uri);
      this.documents.set(request.uri, previous);
      return previous;
    }
    let ast: PhpNode;
    try {
      const engine = new Engine({
        parser: { version: '8.4', suppressErrors: false },
        ast: { withPositions: true, withSource: false }
      });
      const parsed = asNode(engine.parseCode(request.text, request.uri));
      if (
        !parsed ||
        parsed.kind !== 'program' ||
        (Array.isArray(parsed.errors) && parsed.errors.length)
      ) {
        throw new PhpAnalysisError('invalid-syntax');
      }
      ast = parsed;
    } catch (error) {
      throw new PhpAnalysisError(error instanceof RangeError ? 'analysis-limit' : 'invalid-syntax');
    }
    checkCancellation(cancellation);
    const document = new PhpDocument(request, ast, this.limits, cancellation);
    this.documents.delete(request.uri);
    this.documents.set(request.uri, document);
    while (this.documents.size > this.limits.maxCacheEntries) {
      this.documents.delete(this.documents.keys().next().value!);
    }
    return document;
  }

  invalidate(uri: string): void {
    this.documents.delete(uri);
  }
  clear(): void {
    this.documents.clear();
  }
}
