import type { FlowEdge, FlowGraph, FlowNode, SourceLocation, SourcePosition } from './model.js';

export type FlowDetail = 'simplified' | 'detailed';
export interface FlowPresentation {
  /** A visual projection only. Never use this graph for analysis or session persistence. */
  readonly graph: FlowGraph;
  readonly members: ReadonlyMap<string, readonly FlowNode[]>;
  readonly nodeForSource: ReadonlyMap<string, string>;
  readonly hiddenExceptionEdges: number;
  readonly hiddenMergeNodes: number;
}

export function defaultFlowDetail(graph: FlowGraph): FlowDetail {
  // The PHP adapter includes this discriminator even for untitled/extensionless buffers.
  return /#php:\d+:/.test(graph.rootSymbolId) ? 'simplified' : 'detailed';
}

const before = (a: SourcePosition, b: SourcePosition): boolean =>
  a.line < b.line || (a.line === b.line && a.character <= b.character);
const contains = (outer?: SourceLocation, inner?: SourceLocation): boolean =>
  !!outer &&
  !!inner &&
  outer.uri === inner.uri &&
  before(outer.start, inner.start) &&
  before(inner.end, outer.end);
const sameScope = (a: FlowNode, b: FlowNode): boolean => a.parentNodeId === b.parentNodeId;
const simple = (node: FlowNode): boolean =>
  (node.kind === 'call' || node.kind === 'operation') &&
  !/^(try$|finally \(|case\b|default\b)/.test(node.label);

function indexEdges(
  edges: readonly FlowEdge[],
  side: 'source' | 'target'
): Map<string, FlowEdge[]> {
  const index = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const items = index.get(edge[side]) ?? [];
    items.push(edge);
    index.set(edge[side], items);
  }
  return index;
}

/**
 * Lossless source mapping with a deliberately smaller visual surface:
 * - only expression-contained, single-entry linear evaluation chains are folded;
 * - branches, catches, loops, explicit throws and finalizer completions stay distinct;
 * - optional uncaught `may throw` edges are hidden, not declared impossible;
 * - references remain navigation, never become execution edges.
 * Input nodes, edges, diagnostics and source IDs are never changed.
 */
export function presentFlowGraph(graph: FlowGraph, detail: FlowDetail): FlowPresentation {
  const identity = (): FlowPresentation => ({
    graph,
    members: new Map(graph.nodes.map((node) => [node.id, [node]])),
    nodeForSource: new Map(graph.nodes.map((node) => [node.id, node.id])),
    hiddenExceptionEdges: 0,
    hiddenMergeNodes: 0
  });
  if (detail === 'detailed') return identity();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let hiddenExceptionEdges = 0;
  const filtered = graph.edges.filter((edge) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    const hide =
      edge.kind === 'exception' &&
      edge.label === 'may throw' &&
      target?.kind === 'exit' &&
      !target.source &&
      !!source &&
      ['call', 'operation', 'condition'].includes(source.kind) &&
      sameScope(source, target);
    if (hide) hiddenExceptionEdges++;
    return !hide;
  });

  // Bypass only structural joins with one unlabeled normal continuation. Preserve
  // the incoming edge kind/label (including true/false and break/continue).
  const outgoing = indexEdges(filtered, 'source');
  const incoming = indexEdges(filtered, 'target');
  const bypass = new Map<string, string>();
  for (const node of graph.nodes) {
    const outputs = outgoing.get(node.id) ?? [];
    const inputs = incoming.get(node.id) ?? [];
    const edge = outputs[0];
    if (
      node.kind === 'merge' &&
      !node.source &&
      outputs.length === 1 &&
      inputs.length > 0 &&
      inputs.every((item) => item.kind !== 'reference') &&
      edge?.kind === 'normal' &&
      !edge.label &&
      edge.target !== node.id &&
      nodes.has(edge.target) &&
      sameScope(node, nodes.get(edge.target)!)
    )
      bypass.set(node.id, edge.target);
  }
  const remapped = new Map<string, string>();
  const destination = (id: string): string => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current = id;
    while (bypass.has(current) && !remapped.has(current)) {
      if (seen.has(current)) {
        // A malformed or cyclic join chain is not simplified.
        for (const item of path) remapped.set(item, item);
        return id;
      }
      seen.add(current);
      path.push(current);
      current = bypass.get(current)!;
    }
    const target = remapped.get(current) ?? current;
    for (const item of path) remapped.set(item, target);
    return target;
  };
  for (const id of bypass.keys()) destination(id);
  const hiddenMerges = new Set([...bypass.keys()].filter((id) => destination(id) !== id));
  const edges = filtered
    .filter((edge) => !hiddenMerges.has(edge.source))
    .map((edge) => ({ ...edge, target: destination(edge.target) }));
  const ins = indexEdges(edges, 'target');
  const outs = indexEdges(edges, 'source');
  interface Group {
    representative: FlowNode;
    entry: string;
    members: FlowNode[];
  }
  const groups = new Map<string, Group>();
  const owners = new Map<string, Group>();
  for (const node of graph.nodes) {
    if (hiddenMerges.has(node.id)) continue;
    const group = { representative: node, entry: node.id, members: [node] };
    groups.set(node.id, group);
    owners.set(node.id, group);
  }
  const absorb = (target: Group, source: Group): void => {
    for (const member of source.members) {
      target.members.push(member);
      owners.set(member.id, target);
    }
    groups.delete(source.representative.id);
  };

  // Detached, unexpanded reference leaves are details of their owning operation.
  // Expanded implementations remain visible and continue to use original call IDs.
  for (const node of graph.nodes) {
    const input = ins.get(node.id) ?? [];
    if (node.kind !== 'call' || input.length !== 1 || input[0]?.kind !== 'reference') continue;
    if ((outs.get(node.id)?.length ?? 0) !== 0) continue;
    const owner = owners.get(input[0].source);
    const group = owners.get(node.id);
    if (
      owner &&
      group &&
      owner !== group &&
      sameScope(owner.representative, node) &&
      contains(owner.representative.source, node.source)
    )
      absorb(owner, group);
  }

  // Pull predecessors into the largest containing expression, in reverse order.
  // The leftmost original node carries the group's incoming edges. A multi-entry
  // target or any non-normal continuation is a hard boundary.
  for (const node of [...graph.nodes].reverse()) {
    const target = groups.get(node.id);
    if (!target || (!simple(node) && !['return', 'throw', 'condition', 'exit'].includes(node.kind)))
      continue;
    while (true) {
      const inputs = ins.get(target.entry) ?? [];
      const link = inputs[0];
      if (inputs.length !== 1 || link?.kind !== 'normal' || link.label) break;
      const source = owners.get(link.source);
      if (!source || source === target || !simple(source.representative)) break;
      if (!sameScope(node, source.representative)) break;
      // Do not erase a cycle whose backward edge is exceptional (or normal).
      // Branch/loop node kinds are not the only way a graph can encode a cycle.
      if ((ins.get(source.entry) ?? []).some((edge) => owners.get(edge.source) === target)) break;
      const continuations = (outs.get(source.representative.id) ?? []).filter(
        (edge) => edge.kind !== 'exception' && edge.kind !== 'reference'
      );
      if (
        continuations.length !== 1 ||
        continuations[0]?.target !== target.entry ||
        continuations[0]?.kind !== 'normal' ||
        !source.members.every((member) => contains(node.source, member.source))
      )
        break;
      target.entry = source.entry;
      absorb(target, source);
    }
  }

  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const members = new Map<string, readonly FlowNode[]>();
  const nodeForSource = new Map<string, string>();
  for (const group of groups.values()) {
    group.members.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    members.set(group.representative.id, group.members);
    for (const node of group.members) nodeForSource.set(node.id, group.representative.id);
  }
  for (const id of hiddenMerges)
    nodeForSource.set(id, nodeForSource.get(destination(id)) ?? destination(id));

  const unique = new Map<string, FlowEdge>();
  for (const edge of edges) {
    const source = nodeForSource.get(edge.source) ?? edge.source;
    const target = nodeForSource.get(edge.target) ?? edge.target;
    // Suppress only newly internal edges, never original self-loops.
    if (source === target && edge.source !== edge.target) continue;
    const key = JSON.stringify([source, target, edge.kind, edge.label]);
    if (!unique.has(key)) unique.set(key, { ...edge, source, target });
  }
  const projected: FlowGraph = {
    ...graph,
    nodes: [...groups.values()].map(({ representative }) => ({
      ...representative,
      ...(representative.parentNodeId
        ? {
            parentNodeId:
              nodeForSource.get(representative.parentNodeId) ?? representative.parentNodeId
          }
        : {})
    })),
    edges: [...unique.values()]
  };
  return {
    graph: projected,
    members,
    nodeForSource,
    hiddenExceptionEdges,
    hiddenMergeNodes: hiddenMerges.size
  };
}

/** Pick a real call, never send a synthetic group ID to the extension host. */
export function presentationCall(
  members: readonly FlowNode[],
  selectedId?: string
): FlowNode | undefined {
  const selected = members.find((node) => node.id === selectedId);
  if (selected?.kind === 'call' && selected.expandable) return selected;
  return [...members].reverse().find((node) => node.kind === 'call' && node.expandable);
}
