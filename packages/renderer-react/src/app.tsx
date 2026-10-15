import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import dagre from 'dagre';
import {
  Background,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { expansionAction } from './expansion-action.js';
import {
  FLOW_SCHEMA_VERSION,
  presentationCall,
  type FlowGraph,
  type FlowPresentation,
  type FlowNode
} from '@visual-code-flow/flow-core';
import { useFlowPresentation } from './use-flow-presentation.js';

interface VsCodeBridge {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;

const colors: Record<string, string> = {
  entry: '#047857',
  exit: '#047857',
  condition: '#a16207',
  loop: '#92400e',
  call: '#1d4ed8',
  return: '#4f46e5',
  throw: '#b91c1c',
  unsupported: '#be123c',
  merge: '#475569',
  operation: '#334155'
};

function nodeStyle(node: FlowNode): NonNullable<Node['style']> {
  return {
    background: colors[node.kind] ?? '#334155',
    color: '#f8fafc',
    border: '1px solid rgba(255,255,255,.22)',
    borderRadius: node.kind === 'entry' || node.kind === 'exit' ? 24 : 10,
    padding: 12,
    fontSize: 12,
    lineHeight: 1.5,
    width: 260,
    maxWidth: 260,
    whiteSpace: 'normal',
    boxShadow: '0 4px 16px rgba(0,0,0,.16)'
  };
}

function layoutGraph(
  presentation: FlowPresentation,
  direction: 'TB' | 'LR'
): { nodes: Node[]; edges: Edge[] } {
  const graph = presentation.graph;
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: direction, ranksep: 65, nodesep: 30 });
  layout.setDefaultEdgeLabel(() => ({}));

  const height = (id: string): number =>
    (presentation.members.get(id)?.length ?? 0) > 1 ? 110 : 90;
  for (const node of graph.nodes) layout.setNode(node.id, { width: 260, height: height(node.id) });
  for (const edge of graph.edges) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);

  const nodes: Node[] = graph.nodes.map((node) => {
    const position = layout.node(node.id);
    return {
      id: node.id,
      data: {
        label: (
          <div>
            <span className="flow-node-label" title={node.label}>
              {node.label}
            </span>
            {(presentation.members.get(node.id)?.length ?? 0) > 1 && (
              <span className="flow-node-detail-count">
                {presentation.members.get(node.id)!.length} steps grouped
              </span>
            )}
          </div>
        )
      },
      type: 'default',
      ariaLabel: `${node.kind}: ${node.label}. ${presentation.members.get(node.id)?.length ?? 1} source steps`,
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
      position: { x: position.x - 130, y: position.y - height(node.id) / 2 },
      style: nodeStyle(node)
    };
  });
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? (edge.kind === 'normal' ? undefined : edge.kind),
    type: 'smoothstep',
    animated: edge.kind === 'loop-back',
    style: { stroke: '#94a3b8', strokeDasharray: edge.kind === 'reference' ? '5 5' : undefined },
    labelStyle: { fill: 'var(--vscode-foreground)', fontSize: 11 }
  }));
  return { nodes, edges };
}

function FlowApp() {
  const [status, setStatus] = useState('Select a function to view its flow.');
  const { graph, setGraph, detail, setDetail, presentation } = useFlowPresentation();
  const [showDetails, setShowDetails] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | undefined>();
  const [expandedNodeIds, setExpandedNodeIds] = useState<readonly string[]>([]);
  const [layoutDirection, setLayoutDirection] = useState<'TB' | 'LR'>('TB');
  const bridge = useMemo(() => acquireVsCodeApi(), []);
  const view = useMemo(
    () => (presentation ? layoutGraph(presentation, layoutDirection) : undefined),
    [presentation, layoutDirection]
  );
  const expanded = useMemo(() => new Set(expandedNodeIds), [expandedNodeIds]);
  const selectedNode = graph?.nodes.find((node) => node.id === highlightedNodeId);
  const selectedViewId = highlightedNodeId
    ? presentation?.nodeForSource.get(highlightedNodeId)
    : undefined;
  const selectedMembers = selectedViewId ? (presentation?.members.get(selectedViewId) ?? []) : [];
  const selectedCall = presentationCall(selectedMembers, highlightedNodeId);
  const highlightedNodes = useMemo(
    () =>
      view?.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedViewId
      })),
    [view, selectedViewId]
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      if (data.type === 'node:highlight') {
        setHighlightedNodeId(
          'nodeId' in data && typeof data.nodeId === 'string' ? data.nodeId : undefined
        );
      }
      if (data.type === 'settings' && 'layoutDirection' in data) {
        if (data.layoutDirection === 'TB' || data.layoutDirection === 'LR') {
          setLayoutDirection(data.layoutDirection);
        }
      }
      if (data.type === 'status' && 'message' in data && typeof data.message === 'string') {
        setStatus(data.message);
      }
      if (data.type === 'expanded' && 'nodeIds' in data && Array.isArray(data.nodeIds)) {
        setExpandedNodeIds(data.nodeIds.filter((id): id is string => typeof id === 'string'));
      }
      if (
        data.type === 'graph' &&
        'graph' in data &&
        typeof data.graph === 'object' &&
        data.graph !== null &&
        'schemaVersion' in data.graph &&
        data.graph.schemaVersion === FLOW_SCHEMA_VERSION
      ) {
        setGraph(data.graph as FlowGraph);
      }
    };
    window.addEventListener('message', onMessage);
    bridge.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [bridge, setGraph]);

  const chooseNode = (nodeId: string): void => {
    setHighlightedNodeId(nodeId || undefined);
    if (nodeId) bridge.postMessage({ type: 'node:selected', nodeId });
  };

  const toggleExpansion = (node: FlowNode): void => {
    const action = expansionAction(node, expanded);
    if (action) bridge.postMessage(action);
  };

  const onNodeClick: NodeMouseHandler = (_, node) => chooseNode(node.id);
  const onNodeDoubleClick: NodeMouseHandler = (_, node) => {
    const target = presentationCall(presentation?.members.get(node.id) ?? [], highlightedNodeId);
    if (target) toggleExpansion(target);
  };

  return (
    <section className="flow-shell">
      <header className="flow-header">
        <div className="flow-brand">
          <span className="flow-brand-icon" aria-hidden="true">
            ◈
          </span>
          <div>
            <strong>Visual Code Flow</strong>
            <p role="status" className="flow-status">
              {status}
            </p>
          </div>
          <span className="flow-count">
            {presentation?.graph.nodes.length ?? 0}
            {detail === 'simplified' && graph ? ` / ${graph.nodes.length}` : ''} nodes
          </span>
        </div>
        <div className="flow-toolbar">
          <div className="flow-detail-toggle" role="group" aria-label="Flow detail level">
            {(['simplified', 'detailed'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className="flow-action flow-action-secondary"
                aria-pressed={detail === mode}
                onClick={() => setDetail(mode)}
                disabled={!graph}
              >
                {mode === 'simplified' ? 'Simplified' : 'Detailed'}
              </button>
            ))}
          </div>
          <label htmlFor="flow-node-picker">Navigate</label>
          <select
            id="flow-node-picker"
            aria-label="Select graph node"
            value={selectedViewId ?? ''}
            onChange={(event) => chooseNode(event.target.value)}
          >
            <option value="">Choose node...</option>
            {presentation?.graph.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.kind}: {node.label.slice(0, 72)}
              </option>
            ))}
          </select>
          {graph && (
            <>
              <button
                type="button"
                className="flow-action flow-action-secondary"
                title="Copy the full detailed graph, including grouped steps and exception paths"
                onClick={() => bridge.postMessage({ type: 'diagram:copy' })}
              >
                Copy detailed Mermaid
              </button>
              <button
                type="button"
                className="flow-action flow-action-secondary"
                title="Save the full detailed graph, including grouped steps and exception paths"
                onClick={() => bridge.postMessage({ type: 'diagram:save' })}
              >
                Save detailed .mmd
              </button>
            </>
          )}
          {selectedMembers.length > 1 && (
            <button
              type="button"
              className="flow-action flow-action-secondary"
              aria-expanded={showDetails}
              aria-controls="flow-block-details"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? 'Hide' : 'Show'} {selectedMembers.length} steps
            </button>
          )}
          {selectedCall && (
            <button
              type="button"
              className="flow-action"
              onClick={() => toggleExpansion(selectedCall)}
              title="You can also double-click a call node"
            >
              {expanded.has(selectedCall.id) ? '− Collapse' : '+ Expand call'}
            </button>
          )}
        </div>
        {graph && detail === 'simplified' && (
          <p className="flow-summary-note">
            Expression steps are grouped.{' '}
            {(presentation?.hiddenExceptionEdges ?? 0) > 0
              ? `${presentation!.hiddenExceptionEdges} potential uncaught-exception edges hidden. `
              : ''}
            Use Detailed for all paths. Mermaid exports the full graph.
          </p>
        )}
        {showDetails && selectedMembers.length > 1 && (
          <section
            id="flow-block-details"
            className="flow-block-details"
            aria-label="Original steps in selected block"
          >
            <label htmlFor="flow-step-picker">Source step</label>
            <select
              id="flow-step-picker"
              value={selectedNode?.id ?? ''}
              onChange={(event) => chooseNode(event.target.value)}
            >
              {selectedMembers.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.kind}: {node.label}
                </option>
              ))}
            </select>
            <p>{selectedNode?.label}</p>
          </section>
        )}
        {!!graph?.diagnostics.length && (
          <details className="flow-diagnostics">
            <summary>{graph.diagnostics.length} analysis notes</summary>
            <div>
              {graph.diagnostics.map((diagnostic, index) => (
                <p key={`${diagnostic.code}-${index}`}>
                  {diagnostic.severity}: {diagnostic.message}
                </p>
              ))}
            </div>
          </details>
        )}
      </header>
      <main className="flow-canvas">
        {view && view.nodes.length > 0 ? (
          <ReactFlow
            key={`${graph?.rootSymbolId}:${detail}`}
            nodes={highlightedNodes ?? view.nodes}
            edges={view.edges}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            fitView
            minZoom={0.15}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            colorMode="dark"
            aria-label="Interactive code flow diagram"
          >
            <Background gap={20} color="#475569" />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="flow-empty">
            <div className="flow-empty-icon" aria-hidden="true">
              ◇
            </div>
            <strong>Explore a function</strong>
            <p>Place your cursor inside a function and run Visual Code Flow: Open Flow.</p>
          </div>
        )}
      </main>
      <footer className="flow-footer">
        <span>
          {selectedNode
            ? `${selectedNode.kind.toUpperCase()} · ${selectedNode.label.slice(0, 100)}`
            : 'Click a node to reveal its source'}
        </span>
        <span>Scroll to zoom · Drag canvas to pan · Double-click a call to expand</span>
      </footer>
    </section>
  );
}

const root = document.getElementById('app');
if (root) createRoot(root).render(<FlowApp />);
