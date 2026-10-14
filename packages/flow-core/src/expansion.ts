import type { FlowEdge, FlowGraph, FlowNode } from './model.js';
import { assertValidFlowGraph } from './validation.js';

export type ExpansionFailure = 'not-call' | 'already-expanded' | 'recursive' | 'depth-limit';

export interface ExpansionResult {
  readonly ok: boolean;
  readonly reason?: ExpansionFailure;
}

interface Expansion {
  readonly parentCallId: string;
  readonly graph: FlowGraph;
  readonly depth: number;
  readonly ancestors: readonly string[];
}

/**
 * An expansion is a navigational subgraph, not an inlined execution path.
 * The caller's existing CFG edges are preserved.
 */
export class FlowExpansionSession {
  private readonly expansions = new Map<string, Expansion>();

  constructor(
    readonly root: FlowGraph,
    readonly maxDepth = 3
  ) {
    assertValidFlowGraph(root);
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError('Expansion depth must be a positive integer');
    }
  }

  get expandedCalls(): readonly string[] {
    return [...this.expansions.keys()];
  }

  getGraph(): FlowGraph {
    const nodes: FlowNode[] = this.root.nodes.map((node) => ({
      ...node,
      expandable: node.kind === 'call'
    }));
    const edges: FlowEdge[] = [...this.root.edges];
    const diagnostics = [...this.root.diagnostics];

    for (const expansion of this.expansions.values()) {
      const { parentCallId, graph } = expansion;
      const id = (original: string): string => `${parentCallId}::${original}`;
      nodes.push(
        ...graph.nodes.map((node) => ({
          ...node,
          id: id(node.id),
          parentNodeId: parentCallId,
          expandable: node.kind === 'call'
        }))
      );
      edges.push(
        ...graph.edges.map((edge) => ({
          ...edge,
          id: id(edge.id),
          source: id(edge.source),
          target: id(edge.target)
        }))
      );
      const entry = graph.nodes.find((node) => node.kind === 'entry');
      if (entry) {
        edges.push({
          id: id('implementation-link'),
          source: parentCallId,
          target: id(entry.id),
          kind: 'normal',
          label: 'Implementation (navigation)'
        });
      }
      diagnostics.push(...graph.diagnostics);
    }

    const combined: FlowGraph = { ...this.root, nodes, edges, diagnostics };
    assertValidFlowGraph(combined);
    return combined;
  }

  expand(callId: string, target: FlowGraph): ExpansionResult {
    assertValidFlowGraph(target);
    if (this.expansions.has(callId)) return { ok: false, reason: 'already-expanded' };
    const node = this.getGraph().nodes.find((item) => item.id === callId);
    if (!node || node.kind !== 'call') return { ok: false, reason: 'not-call' };

    const owner = [...this.expansions.values()]
      .filter((expansion) => callId.startsWith(`${expansion.parentCallId}::`))
      .sort((a, b) => b.parentCallId.length - a.parentCallId.length)[0];
    const depth = owner ? owner.depth + 1 : 1;
    const ancestors = owner ? owner.ancestors : [this.root.rootSymbolId];
    if (depth > this.maxDepth) return { ok: false, reason: 'depth-limit' };
    if (ancestors.includes(target.rootSymbolId)) {
      return { ok: false, reason: 'recursive' };
    }

    this.expansions.set(callId, {
      parentCallId: callId,
      graph: target,
      depth,
      ancestors: [...ancestors, target.rootSymbolId]
    });
    return { ok: true };
  }

  collapse(callId: string): boolean {
    if (!this.expansions.has(callId)) return false;
    for (const key of this.expansions.keys()) {
      if (key === callId || key.startsWith(`${callId}::`)) this.expansions.delete(key);
    }
    return true;
  }

  reset(): void {
    this.expansions.clear();
  }
}
