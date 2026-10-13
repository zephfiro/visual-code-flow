import type {
  AnalysisResult,
  SourceSpan,
  StatementDescriptor
} from '@visual-code-flow/shared';
import {
  FLOW_SCHEMA_VERSION,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowNode,
  type FlowNodeKind,
  type SourceLocation
} from './model.js';
import { assertValidFlowGraph } from './validation.js';

interface PendingEdge {
  readonly source: string;
  readonly kind: FlowEdgeKind;
}

interface LoopFrame {
  readonly header: string;
  readonly breaks: string[];
}

const normal = (source: string): PendingEdge => ({ source, kind: 'normal' });

const toLocation = (span: SourceSpan): SourceLocation => ({
  uri: span.uri,
  start: { ...span.start },
  end: { ...span.end }
});

const nodeKind = (kind: StatementDescriptor['kind']): FlowNodeKind => {
  switch (kind) {
    case 'branch':
      return 'condition';
    case 'loop':
      return 'loop';
    case 'call':
      return 'call';
    case 'return':
    case 'throw':
    case 'break':
    case 'continue':
    case 'unsupported':
      return kind === 'break' || kind === 'continue' ? 'operation' : kind;
    default:
      return 'operation';
  }
};

/**
 * Construct a conservative control-flow graph from language-neutral statements.
 *
 * Branches and loops are wired structurally. Unsupported statements stay opaque,
 * rather than inventing paths through their unknown internal structure.
 */
export function buildControlFlowGraph(result: AnalysisResult): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const diagnostics = result.diagnostics.map((message, index) => ({
    code: `analyzer-${index}`,
    message,
    severity: 'warning' as const
  }));
  const entryId = `${result.function.symbolId}:entry`;
  const exitId = `${result.function.symbolId}:exit`;
  let edgeNumber = 0;
  const uniqueIds = new Set<string>();

  function addNode(node: FlowNode): void {
    if (uniqueIds.has(node.id)) throw new Error(`Duplicate statement id: ${node.id}`);
    uniqueIds.add(node.id);
    nodes.push(node);
  }

  function connect(from: readonly PendingEdge[], to: string): void {
    for (const pending of from) {
      edges.push({
        id: `edge-${++edgeNumber}`,
        source: pending.source,
        target: to,
        kind: pending.kind
      });
    }
  }

  addNode({ id: entryId, kind: 'entry', label: result.function.name, expandable: false });
  addNode({ id: exitId, kind: 'exit', label: 'Exit', expandable: false });

  function sequence(
    statements: readonly StatementDescriptor[],
    incoming: readonly PendingEdge[],
    loop?: LoopFrame
  ): PendingEdge[] {
    let pending = [...incoming];
    for (const statement of statements) {
      if (pending.length === 0) break;
      const kind = nodeKind(statement.kind);
      addNode({
        id: statement.id,
        kind,
        label: statement.label || statement.kind,
        source: toLocation(statement.location),
        expandable: false
      });
      connect(pending, statement.id);
      if (statement.kind === 'return' || statement.kind === 'throw') {
        connect(
          [{ source: statement.id, kind: statement.kind === 'throw' ? 'exception' : 'normal' }],
          exitId
        );
        pending = [];
      } else if (statement.kind === 'break' && loop) {
        loop.breaks.push(statement.id);
        pending = [];
      } else if (statement.kind === 'continue' && loop) {
        connect([{ source: statement.id, kind: 'continue' }], loop.header);
        pending = [];
      } else if (statement.kind === 'branch') {
        const yes = sequence(statement.children ?? [], [{ source: statement.id, kind: 'true' }], loop);
        const no = sequence(
          statement.alternate ?? [],
          [{ source: statement.id, kind: 'false' }],
          loop
        );
        const remaining = [...yes, ...no];
        if (remaining.length > 1) {
          const mergeId = `${statement.id}:merge`;
          addNode({ id: mergeId, kind: 'merge', label: 'Merge', expandable: false });
          connect(remaining, mergeId);
          pending = [normal(mergeId)];
        } else {
          pending = remaining;
        }
      } else if (statement.kind === 'loop') {
        const frame: LoopFrame = { header: statement.id, breaks: [] };
        const loopBody = sequence(
          statement.children ?? [],
          [{ source: statement.id, kind: 'true' }],
          frame
        );
        connect(
          loopBody.map(({ source }) => ({ source, kind: 'loop-back' as const })),
          statement.id
        );
        pending = [
          { source: statement.id, kind: 'false' },
          ...frame.breaks.map((source) => ({ source, kind: 'break' as const }))
        ];
      } else {
        if (statement.kind === 'unsupported') {
          diagnostics.push({
            code: `unsupported-${statement.id}`,
            message: `Unsupported control-flow construct: ${statement.label}`,
            severity: 'warning'
          });
        }
        pending = [normal(statement.id)];
      }
    }
    return pending;
  }

  connect(sequence(result.statements, [normal(entryId)]), exitId);
  const graph: FlowGraph = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    rootSymbolId: result.function.symbolId,
    nodes,
    edges,
    diagnostics
  };
  assertValidFlowGraph(graph);
  return graph;
}
