import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from './model.js';
import { defaultFlowDetail, presentFlowGraph, presentationCall } from './presentation.js';
import { assertValidFlowGraph } from './validation.js';

const node = (id: string, kind: FlowNode['kind'], start = 0, end = 10): FlowNode => ({
  id,
  kind,
  label: id,
  expandable: kind === 'call',
  ...(!['entry', 'exit', 'merge'].includes(kind)
    ? {
        source: {
          uri: 'file:///test.php',
          start: { line: 0, character: start },
          end: { line: 0, character: end }
        }
      }
    : {})
});
const edge = (
  source: string,
  target: string,
  kind: FlowEdge['kind'] = 'normal',
  label?: string
): FlowEdge => ({
  id: `${source}-${target}-${kind}`,
  source,
  target,
  kind,
  ...(label ? { label } : {})
});
const graph = (nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowGraph => ({
  schemaVersion: FLOW_SCHEMA_VERSION,
  rootSymbolId: 'file:///test.php#php:0:run',
  nodes,
  edges,
  diagnostics: []
});

test('detailed mode retains exact graph identity and PHP-only default includes untitled buffers', () => {
  const input = graph([node('entry', 'entry'), node('exit', 'exit')], [edge('entry', 'exit')]);
  assert.equal(presentFlowGraph(input, 'detailed').graph, input);
  assert.equal(defaultFlowDetail(input), 'simplified');
  assert.equal(
    defaultFlowDetail({ ...input, rootSymbolId: 'untitled:Untitled-1#php:0:run' }),
    'simplified'
  );
  assert.equal(defaultFlowDetail({ ...input, rootSymbolId: 'file:///app.ts#run' }), 'detailed');
});

test('nested expression nodes fold into their whole return without mutating source or diagnostics', () => {
  const input = graph(
    [
      node('entry', 'entry'),
      node('a', 'call', 7, 10),
      node('b', 'call', 7, 20),
      node('ret', 'return', 0, 21),
      node('exit', 'exit')
    ],
    [
      edge('entry', 'a'),
      edge('a', 'b'),
      edge('b', 'ret'),
      edge('ret', 'exit'),
      edge('a', 'exit', 'exception', 'may throw')
    ]
  );
  const original = JSON.stringify(input);
  const view = presentFlowGraph(input, 'simplified');
  assert.deepEqual(
    view.graph.nodes.map((n) => n.id),
    ['entry', 'ret', 'exit']
  );
  assert.deepEqual(
    view.members.get('ret')?.map((n) => n.id),
    ['a', 'b', 'ret']
  );
  assert.equal(view.nodeForSource.get('a'), 'ret');
  assert.equal(view.hiddenExceptionEdges, 1);
  assert.equal(view.graph.diagnostics, input.diagnostics);
  assert.equal(JSON.stringify(input), original);
  assertValidFlowGraph(view.graph);
});

test('independent statements and conditional entries are never folded together', () => {
  const input = graph(
    [
      node('entry', 'entry'),
      node('a', 'call', 0, 3),
      node('b', 'operation', 4, 8),
      node('c', 'condition', 0, 20),
      node('ret', 'return', 0, 30),
      node('exit', 'exit')
    ],
    [
      edge('entry', 'a'),
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'ret', 'true'),
      edge('c', 'exit', 'false'),
      edge('ret', 'exit')
    ]
  );
  const view = presentFlowGraph(input, 'simplified');
  assert.notEqual(view.nodeForSource.get('c'), view.nodeForSource.get('ret'));
  const independent = presentFlowGraph(
    graph(input.nodes.slice(0, 3), input.edges.slice(0, 2)),
    'simplified'
  );
  assert.equal(independent.graph.nodes.length, 3);
});

test('explicit/caught exceptions, finally markers and unsupported diagnostics remain visible', () => {
  const input = graph(
    [
      node('entry', 'entry'),
      node('a', 'call', 0, 3),
      node('b', 'call', 0, 8),
      node('catch', 'condition', 10, 15),
      { ...node('finally', 'operation', 0, 30), label: 'finally (throw)' },
      node('throw', 'throw'),
      node('opaque', 'unsupported'),
      node('exit', 'exit')
    ],
    [
      edge('entry', 'a'),
      edge('a', 'b'),
      edge('a', 'catch', 'exception', 'may throw'),
      edge('b', 'catch', 'exception', 'may throw'),
      edge('b', 'finally'),
      edge('catch', 'throw', 'true'),
      edge('catch', 'finally', 'false'),
      edge('throw', 'exit', 'exception', 'throw'),
      edge('finally', 'opaque'),
      edge('opaque', 'exit', 'exception', 'may throw')
    ]
  );
  const view = presentFlowGraph(input, 'simplified');
  for (const id of ['catch', 'finally', 'throw', 'opaque'])
    assert.ok(view.graph.nodes.some((n) => n.id === id));
  assert.equal(
    view.graph.edges.filter((e) => e.target === 'catch' && e.kind === 'exception').length,
    1
  );
  assert.ok(view.graph.edges.some((e) => e.source === 'throw' && e.label === 'throw'));
  assert.ok(view.graph.edges.some((e) => e.source === 'opaque' && e.kind === 'exception'));
});

test('structural merge bypass preserves branch labels, but never hides a source-backed merge', () => {
  const input = graph(
    [
      node('entry', 'entry'),
      node('decision', 'condition'),
      node('a', 'operation'),
      node('join', 'merge'),
      node('ret', 'return'),
      node('exit', 'exit')
    ],
    [
      edge('entry', 'decision'),
      edge('decision', 'a', 'true'),
      edge('decision', 'join', 'false', 'no'),
      edge('a', 'join'),
      edge('join', 'ret'),
      edge('ret', 'exit')
    ]
  );
  const view = presentFlowGraph(input, 'simplified');
  assert.equal(view.hiddenMergeNodes, 1);
  assert.equal(view.nodeForSource.get('join'), 'ret');
  assert.ok(
    view.graph.edges.some(
      (e) => e.source === 'decision' && e.target === 'ret' && e.kind === 'false' && e.label === 'no'
    )
  );
  assert.notEqual(
    view.nodeForSource.get('a'),
    view.nodeForSource.get('ret'),
    'join still has multiple entries'
  );
  assertValidFlowGraph(view.graph);
});

test('unexpanded reference leaves become details; expanded implementations keep their reference edge', () => {
  const input = graph(
    [
      node('entry', 'entry'),
      node('opaque', 'unsupported', 0, 40),
      node('ref', 'call', 3, 10),
      node('exit', 'exit')
    ],
    [
      edge('entry', 'opaque'),
      edge('opaque', 'ref', 'reference', 'evaluation order unknown'),
      edge('opaque', 'exit')
    ]
  );
  const collapsed = presentFlowGraph(input, 'simplified');
  assert.equal(collapsed.nodeForSource.get('ref'), 'opaque');
  assert.equal(presentationCall(collapsed.members.get('opaque')!)?.id, 'ref');
  const expanded = presentFlowGraph(
    {
      ...input,
      nodes: [...input.nodes, { ...node('callee', 'entry'), parentNodeId: 'ref' }],
      edges: [...input.edges, edge('ref', 'callee', 'reference', 'Implementation (navigation)')]
    },
    'simplified'
  );
  assert.equal(expanded.nodeForSource.get('ref'), 'ref');
  assert.ok(
    expanded.graph.edges.some(
      (e) => e.source === 'ref' && e.target === 'callee' && e.kind === 'reference'
    )
  );
});

test('no merging across files, scopes, loop backedges or labeled completions', () => {
  for (const kind of ['loop-back', 'continue', 'break', 'reference'] as const) {
    const input = graph(
      [node('a', 'call', 0, 2), node('b', 'operation', 0, 20)],
      [edge('a', 'b', kind)]
    );
    assert.notEqual(presentFlowGraph(input, 'simplified').nodeForSource.get('a'), 'b');
  }
  for (const overrides of [
    { parentNodeId: 'other' },
    {
      source: {
        uri: 'file:///other.php',
        start: { line: 0, character: 0 },
        end: { line: 0, character: 20 }
      }
    }
  ]) {
    const input = graph(
      [node('a', 'call', 0, 2), { ...node('b', 'operation', 0, 20), ...overrides }],
      [edge('a', 'b')]
    );
    assert.equal(presentFlowGraph(input, 'simplified').graph.nodes.length, 2);
  }
  const resume = graph(
    [node('a', 'operation'), node('b', 'return')],
    [edge('a', 'b', 'normal', 'resume return')]
  );
  assert.equal(presentFlowGraph(resume, 'simplified').graph.nodes.length, 2);
});

test('cyclic merges terminate, true and false parallel edges remain distinct, self-loops survive', () => {
  const input = graph([node('a', 'merge'), node('b', 'merge')], [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(presentFlowGraph(input, 'simplified').graph.nodes.length, 2);
  const loop = graph(
    [node('a', 'condition'), node('b', 'exit')],
    [edge('a', 'a', 'loop-back'), edge('a', 'b', 'true'), edge('a', 'b', 'false')]
  );
  assert.equal(presentFlowGraph(loop, 'simplified').graph.edges.length, 3);
});

test('navigation prefers an explicitly selected original call, otherwise the outermost call', () => {
  const members = [node('inner', 'call'), node('outer', 'call'), node('ret', 'return')];
  assert.equal(presentationCall(members)?.id, 'outer');
  assert.equal(presentationCall(members, 'inner')?.id, 'inner');
  assert.equal(presentationCall([node('ret', 'return')]), undefined);
});

test('bounded 5000-node input retains a complete source mapping', () => {
  const nodes = [node('entry', 'entry')];
  const edges: FlowEdge[] = [];
  for (let i = 1; i < 4999; i++) {
    nodes.push(node(`n${i}`, 'call', 0, i));
    edges.push(edge(i === 1 ? 'entry' : `n${i - 1}`, `n${i}`));
  }
  nodes.push(node('exit', 'exit'));
  edges.push(edge('n4998', 'exit'));
  const result = presentFlowGraph(graph(nodes, edges), 'simplified');
  assert.equal(result.graph.nodes.length, 3);
  assert.equal(result.nodeForSource.size, 5000);
  assert.equal(result.members.get('n4998')?.length, 4998);
});

test('a backwards normal or exceptional edge prevents contraction of a cycle', () => {
  for (const kind of ['normal', 'exception'] as const) {
    const input = graph(
      [node('a', 'call', 0, 2), node('b', 'call', 0, 20)],
      [edge('a', 'b'), edge('b', 'a', kind)]
    );
    const view = presentFlowGraph(input, 'simplified');
    assert.equal(view.graph.nodes.length, 2);
    assert.equal(view.graph.edges.length, 2);
  }
});

test('a merge with a real source is retained for navigation', () => {
  const input = graph(
    [
      node('a', 'entry'),
      { ...node('join', 'merge'), source: node('source', 'operation').source! },
      node('exit', 'exit')
    ],
    [edge('a', 'join'), edge('join', 'exit')]
  );
  assert.equal(presentFlowGraph(input, 'simplified').hiddenMergeNodes, 0);
});
