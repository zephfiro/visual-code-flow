import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import dagre from 'dagre';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FlowGraph, FlowNode } from '@visual-code-flow/flow-core';

interface VsCodeBridge {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeBridge;

const colors: Record<string, string> = {
  entry: '#065f46',
  exit: '#065f46',
  condition: '#92400e',
  loop: '#78350f',
  call: '#1d4ed8',
  return: '#4338ca',
  throw: '#991b1b',
  unsupported: '#9f1239',
  merge: '#475569',
  operation: '#334155'
};

function nodeStyle(node: FlowNode): NonNullable<Node['style']> {
  return {
    background: colors[node.kind] ?? '#334155',
    color: '#f8fafc',
    border: '1px solid rgba(255,255,255,.25)',
    borderRadius: node.kind === 'entry' || node.kind === 'exit' ? 24 : 10,
    padding: 12,
    fontSize: 12,
    lineHeight: 1.5,
    maxWidth: 260,
    whiteSpace: 'normal',
    boxShadow: '0 4px 16px rgba(0,0,0,.16)'
  };
}

function layoutGraph(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  const layout = new dagre.graphlib.Graph();
  layout.setGraph({ rankdir: 'TB', ranksep: 65, nodesep: 30 });
  layout.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: 215, height: 65 });
  }
  for (const edge of graph.edges) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);

  const nodes: Node[] = graph.nodes.map((node) => {
    const position = layout.node(node.id);
    return {
      id: node.id,
      data: { label: node.label },
      type: 'default',
      position: { x: position.x - 107.5, y: position.y - 32.5 },
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
    style: { stroke: '#94a3b8' },
    labelStyle: { fill: 'var(--vscode-foreground)', fontSize: 11 }
  }));

  return { nodes, edges };
}

function FlowApp() {
  const [status, setStatus] = useState('Select a function to view its flow.');
  const [graph, setGraph] = useState<FlowGraph | undefined>();
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | undefined>();
  const bridge = useMemo(() => acquireVsCodeApi(), []);
  const view = useMemo(() => (graph ? layoutGraph(graph) : undefined), [graph]);
  const highlightedNodes = useMemo(
    () =>
      view?.nodes.map((node) => ({
        ...node,
        selected: node.id === highlightedNodeId
      })),
    [view, highlightedNodeId]
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
      if (data.type === 'status' && 'message' in data && typeof data.message === 'string') {
        setStatus(data.message);
      }
      if (
        data.type === 'graph' &&
        'graph' in data &&
        typeof data.graph === 'object' &&
        data.graph !== null &&
        'schemaVersion' in data.graph &&
        data.graph.schemaVersion === 1
      ) {
        setGraph(data.graph as FlowGraph);
      }
    };
    window.addEventListener('message', onMessage);
    bridge.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [bridge]);

  const onNodeClick: NodeMouseHandler = (_, node) => {
    bridge.postMessage({ type: 'node:selected', nodeId: node.id });
  };

  return (
    <section
      style={{
        fontFamily: 'var(--vscode-font-family)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        margin: 0
      }}
    >
      <header
        style={{ padding: '10px 16px', borderBottom: '1px solid var(--vscode-panel-border)' }}
      >
        <strong>Visual Code Flow</strong>
        <p role="status" style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.75 }}>
          {status}
        </p>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view && view.nodes.length > 0 ? (
          <ReactFlow
            nodes={highlightedNodes ?? view.nodes}
            edges={view.edges}
            onNodeClick={onNodeClick}
            fitView
            minZoom={0.15}
            maxZoom={2}
            nodesDraggable={false}
            nodesConnectable={false}
            colorMode="dark"
          >
            <Background gap={20} color="#475569" />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <p style={{ padding: 16, opacity: 0.7 }}>Select a function to generate a flowchart.</p>
        )}
      </div>
    </section>
  );
}

const root = document.getElementById('app');
if (root) createRoot(root).render(<FlowApp />);
