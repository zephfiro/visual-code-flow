import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnalysisResult, StatementDescriptor } from '@visual-code-flow/shared';
import { buildControlFlowGraph } from './build-graph.js';

const where = {
  uri: 'file:///test.ts',
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 }
};

function statement(
  id: string,
  kind: StatementDescriptor['kind'],
  children?: readonly StatementDescriptor[],
  alternate?: readonly StatementDescriptor[]
): StatementDescriptor {
  return {
    id,
    kind,
    label: id,
    location: where,
    ...(children ? { children } : {}),
    ...(alternate ? { alternate } : {})
  };
}

function build(statements: readonly StatementDescriptor[]) {
  const result: AnalysisResult = {
    function: {
      symbolId: 'test',
      name: 'test',
      languageId: 'typescript',
      location: where,
      body: where
    },
    statements,
    diagnostics: []
  };
  return buildControlFlowGraph(result);
}

test('returns terminate branches instead of falling into subsequent statements', () => {
  const graph = build([
    statement('if', 'branch', [statement('early', 'return')]),
    statement('next', 'return')
  ]);
  const outgoing = (source: string) => graph.edges.filter((edge) => edge.source === source);
  assert.deepEqual(outgoing('early').map((edge) => edge.target), ['test:exit']);
  assert.ok(!outgoing('early').some((edge) => edge.target === 'next'));
  assert.ok(graph.edges.some((edge) => edge.source === 'if' && edge.kind === 'false'));
});

test('loops reconnect normal completion and continue, while break exits loop', () => {
  const graph = build([
    statement('loop', 'loop', [
      statement('if', 'branch', [statement('skip', 'continue')]),
      statement('stop', 'break')
    ]),
    statement('after', 'return')
  ]);
  assert.ok(graph.edges.some((edge) => edge.source === 'skip' && edge.target === 'loop'));
  assert.ok(graph.edges.some((edge) => edge.source === 'stop' && edge.target === 'after'));
  assert.ok(graph.edges.some((edge) => edge.source === 'loop' && edge.target === 'after'));
});

test('throw terminates the path with an exceptional exit', () => {
  const graph = build([statement('throw', 'throw'), statement('unreachable', 'return')]);
  assert.ok(graph.edges.some((edge) => edge.source === 'throw' && edge.kind === 'exception'));
  assert.ok(!graph.nodes.some((node) => node.id === 'unreachable'));
});
