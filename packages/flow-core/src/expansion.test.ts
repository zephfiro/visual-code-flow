import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowGraph } from './model.js';
import { FLOW_SCHEMA_VERSION } from './model.js';
import { FlowExpansionSession } from './expansion.js';

function graph(symbol: string, call = true): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    rootSymbolId: symbol,
    nodes: [
      { id: 'entry', kind: 'entry', label: symbol, expandable: false },
      ...(call
        ? [{ id: 'call', kind: 'call' as const, label: 'helper()', expandable: false }]
        : []),
      { id: 'exit', kind: 'exit', label: 'Exit', expandable: false }
    ],
    edges: call
      ? [
          { id: 'first', source: 'entry', target: 'call', kind: 'normal' },
          { id: 'last', source: 'call', target: 'exit', kind: 'normal' }
        ]
      : [{ id: 'direct', source: 'entry', target: 'exit', kind: 'normal' }],
    diagnostics: []
  };
}

test('expand retains caller control-flow edges and creates a navigable child graph', () => {
  const session = new FlowExpansionSession(graph('root'));
  assert.deepEqual(session.expand('call', graph('helper')), { ok: true });
  const result = session.getGraph();
  assert.ok(result.nodes.some((node) => node.id === 'call::entry'));
  assert.ok(result.edges.some((edge) => edge.source === 'call' && edge.target === 'exit'));
  assert.ok(result.edges.some((edge) => edge.source === 'call' && edge.target === 'call::entry'));
  assert.equal(result.nodes.find((node) => node.id === 'call::entry')?.parentNodeId, 'call');
});

test('recursion and maximum depth cannot cause infinite expansion', () => {
  const session = new FlowExpansionSession(graph('root'), 2);
  assert.deepEqual(session.expand('call', graph('helper')), { ok: true });
  assert.deepEqual(session.expand('call::call', graph('root')), {
    ok: false,
    reason: 'recursive'
  });
  assert.deepEqual(session.expand('call::call', graph('third')), { ok: true });
  assert.deepEqual(session.expand('call::call::call', graph('fourth')), {
    ok: false,
    reason: 'depth-limit'
  });
});

test('collapsing a call recursively discards nested expansions', () => {
  const session = new FlowExpansionSession(graph('root'));
  session.expand('call', graph('helper'));
  session.expand('call::call', graph('third'));
  assert.equal(session.collapse('call'), true);
  assert.deepEqual(session.expandedCalls, []);
  assert.equal(session.getGraph().nodes.length, 3);
  assert.equal(session.collapse('call'), false);
});

test('invalid calls and duplicate expansion return explicit reasons', () => {
  const session = new FlowExpansionSession(graph('root'));
  assert.deepEqual(session.expand('entry', graph('helper')), {
    ok: false,
    reason: 'not-call'
  });
  session.expand('call', graph('helper'));
  assert.deepEqual(session.expand('call', graph('helper')), {
    ok: false,
    reason: 'already-expanded'
  });
});
