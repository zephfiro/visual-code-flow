import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMermaid } from './export.js';
import type { FlowGraph } from '@visual-code-flow/flow-core';

test('exports valid shape identifiers and semantic edges', () => {
  const graph: FlowGraph = {
    schemaVersion: 1,
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
    schemaVersion: 1,
    rootSymbolId: 'calc',
    nodes: [],
    edges: [{ id: 'broken', source: 'missing', target: 'missing', kind: 'normal' }],
    diagnostics: []
  };
  assert.throws(() => exportMermaid(graph));
});
