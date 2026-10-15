import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhpLanguageAdapter } from './adapter.js';
import {
  assertValidFlowGraph,
  buildControlFlowGraph,
  FlowExpansionSession,
  presentFlowGraph,
  presentationCall,
  SourceMapIndex
} from '@visual-code-flow/flow-core';

async function analyze(body: string) {
  const adapter = new PhpLanguageAdapter();
  const request = {
    uri: 'file:///app/Http/UserController.php',
    languageId: 'php',
    documentVersion: 1,
    text: '<?php function index($request) {\r\n' + body + '\r\n}'
  };
  const symbol = adapter.findFunction(request, { line: 1, character: 1 })!;
  const graph = new FlowExpansionSession(
    buildControlFlowGraph(await adapter.analyzeFunction(request, symbol))
  ).getGraph();
  return { adapter, request, graph, view: presentFlowGraph(graph, 'simplified') };
}

test('Laravel fluent queries and response helpers become one block per operation/decision/return', async () => {
  const { graph, view } = await analyze(
    [
      " $users = User::where('active', true)->orderBy('name')->get();",
      ' if ($users->isEmpty()) { return response()->json([], 404); }',
      ' return response()->json($users);'
    ].join('\r\n')
  );
  assert.equal(graph.nodes.length, 14);
  assert.equal(view.graph.nodes.length, 6);
  assert.equal(view.graph.edges.length, 6);
  assert.ok(view.hiddenExceptionEdges > 0);
  assert.deepEqual(
    view.graph.nodes.map((n) => n.kind).sort(),
    ['condition', 'entry', 'exit', 'operation', 'return', 'return'].sort()
  );
  assertValidFlowGraph(view.graph);
});

test('source navigation and expansion still use exact raw call IDs within a grouped chain', async () => {
  const { graph, view, adapter, request } = await analyze(
    " $users = User::where('caf\u00e9 \u{1f30a}', true)->orderBy('name')->get();"
  );
  const operation = view.graph.nodes.find((n) => n.kind === 'operation')!;
  const members = view.members.get(operation.id)!;
  assert.equal(members.filter((n) => n.kind === 'call').length, 3);
  const sourceMap = new SourceMapIndex(graph);
  for (const member of members) {
    assert.deepEqual(sourceMap.getSource(member.id), member.source);
    if (member.kind === 'call') {
      assert.ok(adapter.findCallTargetPosition(request, member.source!));
      assert.equal(presentationCall(members, member.id)?.id, member.id);
      assert.equal(view.nodeForSource.get(member.id), operation.id);
    }
  }
  assert.equal(operation.source!.start.line, 1);
});

test('nullsafe, short-circuit and loop branches remain distinct', async () => {
  const { graph, view } = await analyze(
    ' $value = $request?->user()?->name;\r\n if (ready() && allowed()) return $value;\r\n while (again()) { tick(); if (done()) break; }\r\n return null;'
  );
  for (const control of graph.nodes.filter((n) => ['condition', 'loop', 'return'].includes(n.kind)))
    assert.ok(view.graph.nodes.some((n) => n.id === control.id));
  assert.ok(view.graph.edges.some((e) => e.kind === 'loop-back'));
  assert.ok(view.graph.edges.some((e) => e.kind === 'break'));
  assertValidFlowGraph(view.graph);
});

test('try/catch/finally does not lose caught exceptions or mix completion paths', async () => {
  const { graph, view } = await analyze(
    ' try { work(); if (ready()) return response()->json([]); throw new Error(); } catch (Exception $e) { recover(); } finally { cleanup(); }\r\n return null;'
  );
  for (const marker of graph.nodes.filter(
    (n) => n.kind === 'throw' || n.label.startsWith('finally (') || n.label.startsWith('catch')
  ))
    assert.ok(view.graph.nodes.some((n) => n.id === marker.id));
  for (const edge of graph.edges.filter(
    (e) => e.kind === 'exception' && graph.nodes.find((n) => n.id === e.target)?.kind !== 'exit'
  ))
    assert.ok(
      view.graph.edges.some(
        (e) => e.kind === 'exception' && e.target === view.nodeForSource.get(edge.target)
      )
    );
  assertValidFlowGraph(view.graph);
});

test('expanding a grouped service call preserves its navigational implementation link', async () => {
  const { graph } = await analyze(' return service()->calculate();');
  const session = new FlowExpansionSession(graph);
  const call = graph.nodes.find((n) => n.kind === 'call' && n.label.includes('calculate'))!;
  const { graph: target } = await analyze(' return 2;');
  const implementation = { ...target, rootSymbolId: 'file:///service.php#php:0:calculate' };
  assert.ok(session.expand(call.id, implementation).ok);
  const combined = session.getGraph();
  const view = presentFlowGraph(combined, 'simplified');
  const displayedCall = view.nodeForSource.get(call.id)!;
  assert.ok(view.graph.edges.some((e) => e.source === displayedCall && e.kind === 'reference'));
  assert.ok(view.members.get(displayedCall)?.some((n) => n.id === call.id));
  assertValidFlowGraph(view.graph);
  assert.ok(session.collapse(call.id));
  assert.equal(presentFlowGraph(session.getGraph(), 'simplified').graph.nodes.length, 3);
});
