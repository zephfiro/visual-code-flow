import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ConditionDescriptor,
  SelectionArm,
  StatementDescriptor
} from '@visual-code-flow/shared';
import { buildControlFlowGraph, FlowBuildError, type FlowBuildOptions } from './build-graph.js';
import { FLOW_SCHEMA_VERSION, type FlowGraph } from './model.js';
import { serializeFlowGraph } from './validation.js';
import { FlowExpansionSession } from './expansion.js';

const location = {
  uri: 'file:///fixture.php',
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 }
};
const s = (
  id: string,
  kind: StatementDescriptor['kind'] = 'sequence',
  extra: Partial<StatementDescriptor> = {}
): StatementDescriptor => ({ id, kind, label: id, location, ...extra });
const c = (id: string, constant?: boolean): ConditionDescriptor => ({
  kind: 'test',
  id,
  label: id,
  location,
  ...(constant === undefined ? {} : { constant })
});
const arm = (
  id: string,
  body: readonly StatementDescriptor[],
  isDefault = false
): SelectionArm => ({
  id,
  label: id,
  location,
  tests: isDefault ? [] : [c(`${id}:test`)],
  body,
  isDefault
});
const choose = (arms: readonly SelectionArm[], fallthrough = true): StatementDescriptor =>
  s('select', 'selection', {
    selection: {
      arms,
      fallthrough,
      breakable: fallthrough,
      countForContinue: fallthrough,
      unmatched: fallthrough ? 'normal' : 'throw'
    }
  });
function build(statements: readonly StatementDescriptor[], options?: FlowBuildOptions): FlowGraph {
  return buildControlFlowGraph(
    {
      function: { symbolId: 'root', name: 'root', languageId: 'php', location, body: location },
      statements,
      diagnostics: []
    },
    options
  );
}
function reaches(graph: FlowGraph, start: string, target: string): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(
      ...graph.edges
        .filter((edge) => edge.source === id && edge.kind !== 'reference')
        .map((edge) => edge.target)
    );
  }
  return false;
}
const targets = (graph: FlowGraph, id: string) =>
  graph.edges.filter((edge) => edge.source === id).map((edge) => edge.target);

test('short-circuit conditions route directly to true/false branches', () => {
  const graph = build([
    s('if', 'branch', {
      condition: { kind: 'and', left: c('left'), right: c('right') },
      children: [s('yes')],
      alternate: [s('no')]
    })
  ]);
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === 'left' && edge.target === 'right' && edge.kind === 'true'
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === 'left' && edge.target === 'no' && edge.kind === 'false'
    )
  );
  assert.ok(
    !graph.edges.some(
      (edge) => edge.source === 'left' && edge.target === 'right' && edge.kind === 'false'
    )
  );
});

test('switch fall-through goes to the next body without evaluating its case again', () => {
  const graph = build([
    choose([arm('one', [s('first')]), arm('two', [s('second'), s('stop', 'break')])]),
    s('after')
  ]);
  assert.deepEqual(targets(graph, 'first'), ['two:body']);
  assert.ok(!reaches(graph, 'first', 'two:test'));
  assert.ok(reaches(graph, 'stop', 'after'));
});

test('default in the middle is selected only after all explicit tests fail', () => {
  const graph = build([
    choose([
      arm('one', [s('first')]),
      arm('default', [s('fallback')], true),
      arm('two', [s('last')])
    ])
  ]);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.source === 'two:test' && edge.target === 'default:body' && edge.kind === 'false'
    )
  );
  assert.ok(graph.edges.some((edge) => edge.source === 'first' && edge.target === 'default:body'));
  assert.ok(graph.edges.some((edge) => edge.source === 'fallback' && edge.target === 'two:body'));
});

test('match arms never fall through and a missing default has an exceptional exit', () => {
  const graph = build([
    choose([arm('one', [s('first')]), arm('two', [s('second')])], false),
    s('return', 'return')
  ]);
  assert.ok(!reaches(graph, 'first', 'second'));
  assert.ok(reaches(graph, 'first', 'return'));
  assert.ok(!reaches(graph, 'select:unmatched', 'return'));
  assert.deepEqual(targets(graph, 'select:unmatched'), ['root:exit']);
});

test('finally keeps normal and return continuations separate', () => {
  const graph = build([
    s('try', 'try', {
      children: [s('if', 'branch', { children: [s('early', 'return')], alternate: [s('work')] })],
      finalizer: { location, statements: [s('cleanup', 'call')] }
    }),
    s('after', 'return')
  ]);
  assert.ok(!reaches(graph, 'early', 'after'));
  assert.ok(reaches(graph, 'work', 'after'));
  const cleanups = graph.nodes.filter((node) => node.id.startsWith('cleanup@'));
  assert.equal(cleanups.length, 2);
  assert.ok(cleanups.every((node) => node.source?.uri === location.uri));
  assert.ok(!targets(graph, 'early').includes('root:exit'));
});

test('return from finally overrides the pending completion', () => {
  const graph = build([
    s('try', 'try', {
      children: [s('original', 'return')],
      finalizer: { location, statements: [s('override', 'return')] }
    }),
    s('unreachable')
  ]);
  assert.ok(!graph.nodes.some((node) => node.id === 'unreachable'));
  const override = graph.nodes.find((node) => node.id.startsWith('override@'))!;
  assert.ok(reaches(graph, 'original', override.id));
  assert.deepEqual(targets(graph, override.id), ['root:exit']);
});

test('script termination bypasses finally and has no normal continuation', () => {
  const graph = build([
    s('try', 'try', {
      children: [s('terminate', 'exit')],
      finalizer: { location, statements: [s('must-not-run')] }
    }),
    s('unreachable')
  ]);
  assert.deepEqual(targets(graph, 'terminate'), ['root:exit']);
  assert.ok(
    !graph.nodes.some((node) => node.id.startsWith('must-not-run') || node.id === 'unreachable')
  );
});

test('exceptions thrown by a catch do not enter a sibling catch', () => {
  const graph = build([
    s('try', 'try', {
      children: [s('throw', 'throw')],
      handlers: [
        { id: 'first-catch', label: 'First', location, body: [s('rethrow', 'throw')] },
        { id: 'second-catch', label: 'Second', location, body: [s('recover')], catchesAll: true }
      ]
    })
  ]);
  assert.ok(!reaches(graph, 'rethrow', 'second-catch'));
  assert.ok(reaches(graph, 'throw', 'second-catch'));
});

test('catch-all consumes the remaining exceptions without a spurious unmatched path', () => {
  const graph = build([
    s('try', 'try', {
      children: [s('throw', 'throw')],
      handlers: [
        { id: 'all', label: 'Throwable', location, body: [s('recover')], catchesAll: true },
        { id: 'never', label: 'Other', location, body: [s('bad')] }
      ]
    }),
    s('after')
  ]);
  assert.ok(!graph.nodes.some((node) => node.id === 'never'));
  assert.ok(reaches(graph, 'recover', 'after'));
  assert.ok(!graph.edges.some((edge) => edge.source === 'all' && edge.kind === 'false'));
});

test('numbered break crosses nested loops only after finally executes', () => {
  const graph = build([
    s('outer', 'loop', {
      children: [
        s('inner', 'loop', {
          children: [
            s('try', 'try', {
              children: [s('stop', 'break', { jumpLevel: 2 })],
              finalizer: { location, statements: [s('cleanup')] }
            })
          ]
        }),
        s('after-inner')
      ]
    }),
    s('after-outer')
  ]);
  assert.ok(reaches(graph, 'stop', 'after-outer'));
  assert.ok(!reaches(graph, 'stop', 'after-inner'));
  assert.ok(targets(graph, 'stop').some((id) => id.includes(':finally:break:2')));
});

test('continue in a for-style loop executes its update before retesting', () => {
  const graph = build([
    s('loop', 'loop', { children: [s('skip', 'continue'), s('never')], update: [s('increment')] })
  ]);
  assert.deepEqual(targets(graph, 'skip'), ['increment']);
  assert.deepEqual(targets(graph, 'increment'), ['loop']);
  assert.ok(!graph.nodes.some((node) => node.id === 'never'));
});

test('PHP-style switch counts toward numbered continue targets', () => {
  const graph = build([
    s('loop', 'loop', {
      children: [
        choose([arm('default', [s('skip', 'continue', { jumpLevel: 2 })], true)]),
        s('tail')
      ],
      update: [s('increment')]
    })
  ]);
  assert.deepEqual(targets(graph, 'skip'), ['increment']);
  assert.ok(!graph.nodes.some((node) => node.id === 'tail'));
});

test('do-while does not evaluate its condition when the first body terminates', () => {
  const graph = build([
    s('do', 'loop', {
      loopMode: 'posttest',
      condition: c('test'),
      children: [s('early', 'return')]
    }),
    s('after')
  ]);
  assert.ok(graph.nodes.some((node) => node.id === 'early'));
  assert.ok(!graph.nodes.some((node) => node.id === 'test' || node.id === 'after'));
});

test('nested finalizers execute inside-out before returning', () => {
  const graph = build([
    s('outer-try', 'try', {
      children: [
        s('inner-try', 'try', {
          children: [s('return', 'return')],
          finalizer: { location, statements: [s('inner-cleanup')] }
        })
      ],
      finalizer: { location, statements: [s('outer-cleanup')] }
    })
  ]);
  const inner = graph.nodes.find((node) => node.id.startsWith('inner-cleanup@'))!;
  const outer = graph.nodes.find((node) => node.id.startsWith('outer-cleanup@'))!;
  assert.ok(reaches(graph, 'return', inner.id));
  assert.ok(reaches(graph, inner.id, outer.id));
  assert.ok(!reaches(graph, outer.id, inner.id));
});

test('a possible exception in finally can override a pending return and reach an outer catch', () => {
  const graph = build([
    s('outer', 'try', {
      children: [
        s('inner', 'try', {
          children: [s('return', 'return')],
          finalizer: { location, statements: [s('cleanup', 'call', { mayThrow: true })] }
        })
      ],
      handlers: [
        {
          id: 'catch',
          label: 'Throwable',
          location,
          body: [s('recover', 'return')],
          catchesAll: true
        }
      ]
    })
  ]);
  const cleanup = graph.nodes.find((node) => node.id.startsWith('cleanup@'))!;
  assert.ok(reaches(graph, cleanup.id, 'catch'));
  assert.ok(reaches(graph, cleanup.id, 'root:exit'));
});

test('call references are navigable but not execution edges', () => {
  const graph = build([
    s('opaque', 'unsupported', {
      references: [
        {
          id: 'reference',
          label: 'call()',
          location,
          reason: 'Call reference; evaluation order unspecified'
        }
      ]
    }),
    s('after')
  ]);
  assert.ok(graph.edges.some((edge) => edge.target === 'reference' && edge.kind === 'reference'));
  assert.ok(!reaches(graph, 'root:entry', 'reference'));
  assert.ok(reaches(graph, 'root:entry', 'after'));
});

test('invalid jump targets never fall through to subsequent statements', () => {
  const graph = build([s('bad', 'break', { jumpLevel: 2 }), s('after')]);
  assert.ok(!graph.nodes.some((node) => node.id === 'after'));
  assert.ok(graph.diagnostics.some((item) => item.severity === 'error'));
});

test('graph construction enforces node/edge/depth limits and cancellation', () => {
  for (const options of [
    { maxNodes: 2 },
    { maxEdges: 1 },
    { maxDepth: 1 },
    { cancellation: { isCancellationRequested: true } }
  ]) {
    assert.throws(
      () =>
        build([s('branch', 'branch', { children: [s('one')], alternate: [s('two')] })], options),
      FlowBuildError
    );
  }
});

test('schema v1 snapshots are rejected after navigation edges become explicit in v2', () => {
  const graph = build([s('call', 'call')]);
  assert.equal(FLOW_SCHEMA_VERSION, 2);
  const old = { ...graph, schemaVersion: 1 } as unknown as FlowGraph;
  assert.throws(() => serializeFlowGraph(old), /schema version/);
  const session = new FlowExpansionSession(graph);
  assert.equal(
    session.restore({ rootSymbolId: 'root', entries: [{ callId: 'call', graph: old }] }),
    0
  );
});
