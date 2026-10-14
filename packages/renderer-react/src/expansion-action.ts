import type { FlowNode } from '@visual-code-flow/flow-core';

export interface ExpandAction {
  readonly type: 'node:expand' | 'node:collapse';
  readonly nodeId: string;
}

export function expansionAction(
  node: FlowNode,
  expandedNodeIds: ReadonlySet<string>
): ExpandAction | undefined {
  if (node.kind !== 'call' || !node.expandable) return undefined;
  return {
    type: expandedNodeIds.has(node.id) ? 'node:collapse' : 'node:expand',
    nodeId: node.id
  };
}
