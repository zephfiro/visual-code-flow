import type { FlowGraph, FlowNode, SourcePosition } from './model.js';

function compare(a: SourcePosition, b: SourcePosition): number {
  return a.line - b.line || a.character - b.character;
}

function contains(node: FlowNode, uri: string, position: SourcePosition): boolean {
  const source = node.source;
  return Boolean(
    source &&
    source.uri === uri &&
    compare(source.start, position) <= 0 &&
    compare(position, source.end) < 0
  );
}

function spanWeight(node: FlowNode): number {
  if (!node.source) return Number.POSITIVE_INFINITY;
  const { start, end } = node.source;
  return (end.line - start.line) * 1_000_000 + end.character - start.character;
}

/**
 * Immutable lookup index for a specific graph snapshot.
 * Rebuild after source edits or when the graph's version changes.
 */
export class SourceMapIndex {
  private readonly nodesById: ReadonlyMap<string, FlowNode>;
  private readonly byUri: ReadonlyMap<string, readonly FlowNode[]>;

  constructor(graph: FlowGraph) {
    this.nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const buckets = new Map<string, FlowNode[]>();
    for (const node of graph.nodes) {
      if (!node.source) continue;
      const bucket = buckets.get(node.source.uri) ?? [];
      bucket.push(node);
      buckets.set(node.source.uri, bucket);
    }
    for (const bucket of buckets.values()) bucket.sort((a, b) => spanWeight(a) - spanWeight(b));
    this.byUri = buckets;
  }

  getNode(nodeId: string): FlowNode | undefined {
    return this.nodesById.get(nodeId);
  }

  getSource(nodeId: string): FlowNode['source'] {
    return this.nodesById.get(nodeId)?.source;
  }

  findNode(uri: string, position: SourcePosition): FlowNode | undefined {
    return this.byUri.get(uri)?.find((node) => contains(node, uri, position));
  }
}
