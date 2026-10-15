/** The parser boundary intentionally exposes unknown fields, not `any`. */
export interface PhpNode {
  readonly kind: string;
  readonly loc?: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
  readonly [key: string]: unknown;
}

export function asNode(value: unknown): PhpNode | undefined {
  return value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof value.kind === 'string'
    ? (value as PhpNode)
    : undefined;
}

export function nodeList(value: unknown): readonly PhpNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => asNode(item) ?? []);
  const node = asNode(value);
  return node ? [node] : [];
}

export function childrenOf(node: PhpNode): readonly PhpNode[] {
  return Object.entries(node)
    .filter(([key]) => !['loc', 'leadingComments', 'trailingComments', 'comments'].includes(key))
    .flatMap(([, value]) => nodeList(value));
}

export function nameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const node = asNode(value);
  return typeof node?.name === 'string' ? node.name : undefined;
}

export const FUNCTION_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'closure',
  'arrowfunc'
]);
export const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'enum', 'interface']);
