import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMermaid } from './export.js';
import type { FlowGraph } from '@visual-code-flow/flow-core';

test('exports valid shape identifiers and semantic edges', () => {
  const graph: FlowGraph = {
    schemaVersion: 2,
    rootSymbolId: 'calc',
    nodes: [
      { id: 'root with spaces', kind: 'entry', label: 'Start', expandable: false },
      { id: 'decision', kind: 'condition', label: 'value < 0?', expandable: false },
      { id: 'end', kind: 'exit', label: 'Exit', expandable: false }
    ],
    edges: [
      { id: 'a', source: 'root with spaces', target: 'decision', kind: 'normal' },
      { id: 'b', source: 'decision', target: 'end', kind: 'true' }
    ],
    diagnostics: []
  };
  const value = exportMermaid(graph);
  assert.match(value, /^flowchart TD/);
  assert.match(value, /n1\{"value &lt; 0\?"\}/);
  assert.match(value, /n1 -->\|true\| n2/);
  assert.ok(!value.includes('root with spaces'));
});

test('rejects malformed graphs', () => {
  const graph: FlowGraph = {
    schemaVersion: 2,
    rootSymbolId: 'calc',
    nodes: [],
    edges: [{ id: 'broken', source: 'missing', target: 'missing', kind: 'normal' }],
    diagnostics: []
  };
  assert.throws(() => exportMermaid(graph));
});

test('navigation references are exported as dotted edges, not execution steps', () => {
  const graph: FlowGraph = {
    schemaVersion: 2,
    rootSymbolId: 'root',
    diagnostics: [],
    nodes: [
      { id: 'operation', kind: 'unsupported', label: 'Unknown order', expandable: false },
      { id: 'target', kind: 'call', label: 'call("quoted|value")', expandable: false }
    ],
    edges: [
      {
        id: 'reference',
        source: 'operation',
        target: 'target',
        kind: 'reference',
        label: 'Navigation only'
      }
    ]
  };
  const diagram = exportMermaid(graph);
  assert.match(diagram, /n0 -\.->\|Navigation only\| n1/);
  assert.ok(!diagram.includes('n0 -->'));
});
