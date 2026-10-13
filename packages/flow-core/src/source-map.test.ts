import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowGraph } from './model.js';
import { SourceMapIndex } from './source-map.js';

const graph: FlowGraph = {
  schemaVersion: 1,
  rootSymbolId: 'method',
  nodes: [
    {
      id: 'outer',
      kind: 'condition',
      label: 'outer',
      expandable: false,
      source: {
        uri: 'file:///a.ts',
        start: { line: 1, character: 0 },
        end: { line: 8, character: 0 }
      }
    },
    {
      id: 'inner',
      kind: 'operation',
      label: 'inner',
      expandable: false,
      source: {
        uri: 'file:///a.ts',
        start: { line: 3, character: 3 },
        end: { line: 3, character: 12 }
      }
    }
  ],
  edges: [],
  diagnostics: []
};

test('selects narrowest source node and retrieves source by ID', () => {
  const index = new SourceMapIndex(graph);
  assert.equal(index.findNode('file:///a.ts', { line: 3, character: 5 })?.id, 'inner');
  assert.equal(index.findNode('file:///a.ts', { line: 4, character: 0 })?.id, 'outer');
  assert.deepEqual(index.getSource('inner'), graph.nodes[1]?.source);
});

test('does not return node outside interval or in another file', () => {
  const index = new SourceMapIndex(graph);
  assert.equal(index.findNode('file:///b.ts', { line: 3, character: 5 }), undefined);
  assert.equal(index.findNode('file:///a.ts', { line: 8, character: 0 }), undefined);
  assert.equal(index.getNode('missing'), undefined);
});
