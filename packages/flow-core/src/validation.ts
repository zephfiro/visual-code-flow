import { FLOW_SCHEMA_VERSION, type FlowGraph, type SourceLocation } from './model.js';

export class FlowValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid flow graph: ${problems.join('; ')}`);
    this.name = 'FlowValidationError';
  }
}

function validateLocation(location: SourceLocation, at: string, errors: string[]): void {
  if (!location.uri.trim()) errors.push(`${at}: source URI must not be empty`);
  const { start, end } = location;
  const values = [start.line, start.character, end.line, end.character];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    errors.push(`${at}: source positions must be nonnegative safe integers`);
  } else if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    errors.push(`${at}: end must not precede start`);
  }
}

export function validateFlowGraph(graph: FlowGraph): readonly string[] {
  const errors: string[] = [];
  if (graph.schemaVersion !== FLOW_SCHEMA_VERSION) errors.push('unsupported schema version');
  if (!graph.rootSymbolId.trim()) errors.push('rootSymbolId must not be empty');

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id.trim()) errors.push('node id must not be empty');
    if (nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    if (!node.label.trim()) errors.push(`node ${node.id}: label must not be empty`);
    if (node.source) validateLocation(node.source, `node ${node.id}`, errors);
    if (node.parentNodeId === node.id) errors.push(`node ${node.id}: cannot parent itself`);
    if (node.expandable && node.kind !== 'call') {
      errors.push(`node ${node.id}: only call nodes may be expandable`);
    }
  }

  for (const node of graph.nodes) {
    if (node.parentNodeId && !nodeIds.has(node.parentNodeId)) {
      errors.push(`node ${node.id}: unknown parent ${node.parentNodeId}`);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.id.trim()) errors.push('edge id must not be empty');
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) errors.push(`edge ${edge.id}: unknown source ${edge.source}`);
    if (!nodeIds.has(edge.target)) errors.push(`edge ${edge.id}: unknown target ${edge.target}`);
  }

  for (const diagnostic of graph.diagnostics) {
    if (!diagnostic.code.trim()) errors.push('diagnostic code must not be empty');
    if (diagnostic.source) validateLocation(diagnostic.source, 'diagnostic', errors);
  }

  return errors;
}

export function assertValidFlowGraph(graph: FlowGraph): void {
  const errors = validateFlowGraph(graph);
  if (errors.length > 0) throw new FlowValidationError(errors);
}

export function serializeFlowGraph(graph: FlowGraph): string {
  assertValidFlowGraph(graph);
  return JSON.stringify(graph);
}
