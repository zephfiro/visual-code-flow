import type { FlowGraph, FlowNode } from '@visual-code-flow/flow-core';
import { assertValidFlowGraph } from '@visual-code-flow/flow-core';

function escapeLabel(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/\|/g, '&#124;');
}

function renderNode(id: string, node: FlowNode): string {
  const label = escapeLabel(node.label);
  if (node.kind === 'entry' || node.kind === 'exit') return `  ${id}(["${label}"])`;
  if (node.kind === 'condition' || node.kind === 'loop') return `  ${id}{"${label}"}`;
  return `  ${id}["${label}"]`;
}

export function exportMermaid(graph: FlowGraph): string {
  assertValidFlowGraph(graph);
  const aliases = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart TD'];
  for (const node of graph.nodes) {
    lines.push(renderNode(aliases.get(node.id)!, node));
  }
  for (const edge of graph.edges) {
    const from = aliases.get(edge.source)!;
    const to = aliases.get(edge.target)!;
    const label = edge.label ?? (edge.kind === 'normal' ? '' : edge.kind);
    lines.push(
      label
        ? `  ${from} -->|${escapeLabel(label)}| ${to}`
        : `  ${from} --> ${to}`
    );
  }
  return `${lines.join('\n')}\n`;
}
