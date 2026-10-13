import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_SCHEMA_VERSION, type FlowGraph } from './model.js';
import {
  assertValidFlowGraph,
  FlowValidationError,
  serializeFlowGraph,
  validateFlowGraph
} from './validation.js';

const validGraph = (): FlowGraph => ({
  schemaVersion: FLOW_SCHEMA_VERSION,
  rootSymbolId: 'src/example.ts#calculate',
  nodes: [
    { id: 'entry', kind: 'entry', label: 'Start', expandable: false },
    {
      id: 'call',
      kind: 'call',
      label: 'calculate()',
      expandable: true,
      targetSymbolId: 'src/helpers.ts#calculate',
      source: {
        uri: 'file:///src/example.ts',
        start: { line: 2, character: 0 },
        end: { line: 2, character: 12 }
      }
    }
  ],
  edges: [{ id: 'edge-1', source: 'entry', target: 'call', kind: 'normal' }],
  diagnostics: []
});

test('accepts a valid graph and round-trips through JSON', () => {
  const graph = validGraph();
  assert.deepEqual(validateFlowGraph(graph), []);
  assert.deepEqual(JSON.parse(serializeFlowGraph(graph)), graph);
});

test('rejects duplicate node and edge identifiers', () => {
  const graph = validGraph();
  const invalid: FlowGraph = {
    ...graph,
    nodes: [...graph.nodes, graph.nodes[0]!],
    edges: [...graph.edges, graph.edges[0]!]
  };
  assert.match(validateFlowGraph(invalid).join('; '), /duplicate node id/);
  assert.match(validateFlowGraph(invalid).join('; '), /duplicate edge id/);
  assert.throws(() => assertValidFlowGraph(invalid), FlowValidationError);
});

test('rejects edges with unknown endpoints and parent references', () => {
  const graph = validGraph();
  const invalid: FlowGraph = {
    ...graph,
    nodes: [{ ...graph.nodes[0]!, parentNodeId: 'missing' }],
    edges: [{ id: 'broken', source: 'entry', target: 'missing', kind: 'normal' }]
  };
  const errors = validateFlowGraph(invalid).join('; ');
  assert.match(errors, /unknown target/);
  assert.match(errors, /unknown parent/);
});

test('rejects invalid source positions', () => {
  const graph = validGraph();
  const invalid: FlowGraph = {
    ...graph,
    nodes: [
      {
        id: 'bad',
        kind: 'operation',
        label: 'Invalid',
        expandable: false,
        source: {
          uri: 'file:///src/example.ts',
          start: { line: 10, character: 2 },
          end: { line: 9, character: 5 }
        }
      }
    ],
    edges: []
  };
  assert.match(validateFlowGraph(invalid).join('; '), /end must not precede start/);
});
