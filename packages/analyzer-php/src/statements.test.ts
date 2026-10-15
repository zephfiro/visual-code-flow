import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildControlFlowGraph,
  FLOW_SCHEMA_VERSION,
  type FlowGraph,
  type FlowNode
} from '@visual-code-flow/flow-core';
import { PhpLanguageAdapter } from './adapter.js';
import { PhpSource } from './source.js';

async function analyze(body: string) {
  const adapter = new PhpLanguageAdapter();
  const request = {
    uri: 'file:///control.php',
    languageId: 'php',
    documentVersion: 1,
    text: `<?php function root($x = null, $items = []) { ${body} }`
  };
  const symbol = adapter.findFunction(request, { line: 0, character: 6 })!;
  assert.ok(symbol);
  const result = await adapter.analyzeFunction(request, symbol);
  return { graph: buildControlFlowGraph(result), result, request };
}
function one(graph: FlowGraph, label: string, kind?: FlowNode['kind']): FlowNode {
  const found = graph.nodes.find(
    (node) => node.label === label && (kind === undefined || node.kind === kind)
  );
  assert.ok(
    found,
    `Missing node: ${label}; got ${graph.nodes.map((node) => node.label).join(' / ')}`
  );
  return found;
}
function calls(graph: FlowGraph): string[] {
  return graph.nodes.filter((node) => node.kind === 'call').map((node) => node.label);
}
function reachable(graph: FlowGraph, from: string, to: string, exceptions = false): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(
      ...graph.edges
        .filter(
          (edge) =>
            edge.source === id &&
            edge.kind !== 'reference' &&
            (exceptions || edge.kind !== 'exception')
        )
        .map((edge) => edge.target)
    );
  }
  return false;
}
const next = (graph: FlowGraph, node: FlowNode, kind?: string) =>
  graph.edges
    .filter((edge) => edge.source === node.id && (kind === undefined || edge.kind === kind))
    .map((edge) => edge.target);

test('PHP if/elseif/else and early returns do not fall through', async () => {
  const { graph } = await analyze(
    'if ($x) { return first(); } elseif (ready()) { return second(); } else { fallback(); } after();'
  );
  const early = one(graph, 'return first();', 'return');
  const after = one(graph, 'after()', 'call');
  assert.equal(reachable(graph, early.id, after.id, true), false);
  assert.ok(reachable(graph, one(graph, 'fallback()', 'call').id, after.id));
  assert.equal(graph.schemaVersion, FLOW_SCHEMA_VERSION);
});

test('left-to-right argument evaluation happens before the outer call', async () => {
  const { graph } = await analyze('return consume(first(), second());');
  const first = one(graph, 'first()', 'call'),
    second = one(graph, 'second()', 'call'),
    outer = one(graph, 'consume(first(), second())', 'call');
  assert.ok(reachable(graph, first.id, second.id));
  assert.ok(reachable(graph, second.id, outer.id));
  assert.equal(reachable(graph, second.id, first.id), false);
});

test('named arguments keep source evaluation order rather than parameter-name order', async () => {
  const { graph } = await analyze('consume(second: two(), first: one());');
  assert.ok(reachable(graph, one(graph, 'two()', 'call').id, one(graph, 'one()', 'call').id));
  assert.equal(
    reachable(graph, one(graph, 'one()', 'call').id, one(graph, 'two()', 'call').id),
    false
  );
});

test('short-circuit branches do not evaluate the right call on the wrong path', async () => {
  const { graph } = await analyze('if (left() && right()) { yes(); } else { no(); }');
  const left = one(graph, 'left()', 'condition'),
    right = one(graph, 'right()', 'call');
  const falseTarget = next(graph, left, 'false')[0]!;
  assert.equal(reachable(graph, falseTarget, right.id), false);
  assert.ok(reachable(graph, falseTarget, one(graph, 'no()', 'call').id));
  assert.ok(reachable(graph, next(graph, left, 'true')[0]!, right.id));
});

test('logical OR and negation preserve branch polarity', async () => {
  const { graph } = await analyze('if (!(left() || right())) { no(); } else { yes(); }');
  const left = one(graph, 'left()', 'condition');
  assert.ok(reachable(graph, next(graph, left, 'true')[0]!, one(graph, 'yes()', 'call').id));
  assert.equal(
    reachable(graph, next(graph, left, 'true')[0]!, one(graph, 'right()', 'call').id),
    false
  );
});

test('constant false AND never creates execution nodes for the skipped branch', async () => {
  const { graph } = await analyze('if (false && skipped()) { unreachable(); } after();');
  assert.deepEqual(calls(graph), ['after()']);
});

test('ternary condition branches test only the selected result', async () => {
  const { graph } = await analyze('if ($x ? a() : b()) { yes(); } else { no(); }');
  const condition = one(graph, '$x', 'condition');
  assert.equal(
    reachable(graph, next(graph, condition, 'true')[0]!, one(graph, 'b()', 'call').id),
    false
  );
  assert.equal(
    reachable(graph, next(graph, condition, 'false')[0]!, one(graph, 'a()', 'call').id),
    false
  );
});

test('Elvis and coalescing evaluate the left expression once', async () => {
  const { graph } = await analyze('$value = first() ?: second(); return third() ?? fourth();');
  for (const label of ['first()', 'second()', 'third()', 'fourth()'])
    assert.equal(calls(graph).filter((item) => item === label).length, 1);
  const guard = one(graph, 'Value is set and not null: third()', 'condition');
  assert.equal(
    reachable(graph, next(graph, guard, 'true')[0]!, one(graph, 'fourth()', 'call').id),
    false
  );
});

test('coalescing assignment does not execute its RHS when the value is present', async () => {
  const { graph } = await analyze('$x ??= compute(); after();');
  const guard = one(graph, 'Value is set and not null: $x', 'condition');
  assert.equal(
    reachable(graph, next(graph, guard, 'true')[0]!, one(graph, 'compute()', 'call').id),
    false
  );
});

test('assignments used as conditions preserve the RHS short-circuit outcome', async () => {
  const { graph } = await analyze(
    'if ($value = false && skipped()) { impossible(); } else { normal(); }'
  );
  assert.deepEqual(calls(graph), ['normal()']);
});

test('for initialization runs once and continue executes updates before the test', async () => {
  const { graph } = await analyze(
    'for (start(); prefix(), ready(); update()) { if ($x) continue; body(); } after();'
  );
  assert.equal(calls(graph).filter((label) => label === 'start()').length, 1);
  const continueNode = one(graph, 'continue;', 'operation');
  const update = one(graph, 'update()', 'call');
  assert.ok(reachable(graph, continueNode.id, update.id));
  assert.ok(reachable(graph, update.id, one(graph, 'prefix()', 'call').id));
  assert.equal(reachable(graph, update.id, one(graph, 'start()', 'call').id), false);
});

test('empty for test is unconditionally true until an explicit break', async () => {
  const { graph } = await analyze('for (;;) { return; } never();');
  assert.equal(calls(graph).includes('never()'), false);
  assert.ok(graph.nodes.some((node) => node.label === 'For condition (always true)'));
});

test('foreach evaluates its source once and supports numbered break', async () => {
  const { graph } = await analyze(
    'while (ready()) { foreach (items() as $item) { break 2; } innerAfter(); } outerAfter();'
  );
  const jump = one(graph, 'break 2;', 'operation');
  assert.ok(reachable(graph, jump.id, one(graph, 'outerAfter()', 'call').id));
  assert.equal(reachable(graph, jump.id, one(graph, 'innerAfter()', 'call').id), false);
  assert.equal(calls(graph).filter((label) => label === 'items()').length, 1);
});

test('do/while with an unconditional return never evaluates the test', async () => {
  const { graph } = await analyze('do { return first(); } while (never()); after();');
  assert.deepEqual(calls(graph), ['first()']);
});

test('switch fall-through goes to the next body, not its case expression', async () => {
  const { graph } = await analyze(
    'switch (subject()) { case firstKey(): firstBody(); case secondKey(): secondBody(); break; default: fallback(); } after();'
  );
  const first = one(graph, 'firstBody()', 'call');
  assert.ok(reachable(graph, first.id, one(graph, 'secondBody()', 'call').id));
  assert.equal(reachable(graph, first.id, one(graph, 'secondKey()', 'call').id), false);
  assert.equal(calls(graph).filter((label) => label === 'subject()').length, 1);
});

test('switch default in the middle is selected only after testing remaining cases', async () => {
  const { graph } = await analyze(
    'switch ($x) { case 1: a(); break; default: fallback(); case key(): b(); }'
  );
  const firstTest = one(graph, 'Selected value == 1', 'condition');
  assert.ok(reachable(graph, next(graph, firstTest, 'false')[0]!, one(graph, 'key()', 'call').id));
  assert.ok(reachable(graph, one(graph, 'fallback()', 'call').id, one(graph, 'b()', 'call').id));
  assert.equal(
    reachable(graph, one(graph, 'fallback()', 'call').id, one(graph, 'key()', 'call').id),
    false
  );
});

test('match arms have strict comparisons and never fall through', async () => {
  const { graph } = await analyze('return match (subject()) { key(), 2 => a(), default => b() };');
  assert.ok(graph.nodes.some((node) => node.label === 'Selected value === key()'));
  assert.equal(reachable(graph, one(graph, 'a()', 'call').id, one(graph, 'b()', 'call').id), false);
  assert.equal(calls(graph).filter((label) => label === 'subject()').length, 1);
});

test('unmatched match throws rather than continuing normally', async () => {
  const { graph } = await analyze('$value = match ($x) { 1 => one() }; after();');
  const unmatched = graph.nodes.find(
    (node) => node.kind === 'throw' && node.label.includes('Unhandled match')
  )!;
  assert.ok(unmatched);
  assert.equal(reachable(graph, unmatched.id, one(graph, 'after()', 'call').id, true), false);
});

test('finally runs on return but never resumes the normal after-try path', async () => {
  const { graph } = await analyze(
    'try { if ($x) return 1; work(); } finally { cleanup(); } after();'
  );
  const early = one(graph, 'return 1;', 'return');
  assert.ok(calls(graph).filter((label) => label === 'cleanup()').length >= 2);
  assert.equal(reachable(graph, early.id, one(graph, 'after()', 'call').id, true), false);
  assert.ok(
    graph.nodes
      .filter((node) => node.label === 'cleanup()')
      .some((node) => reachable(graph, early.id, node.id))
  );
});

test('a finalizer return overrides an earlier throw', async () => {
  const { graph } = await analyze('try { throw $x; } finally { return 2; } never();');
  assert.ok(
    reachable(
      graph,
      one(graph, 'throw $x;', 'throw').id,
      one(graph, 'return 2;', 'return').id,
      true
    )
  );
  assert.equal(calls(graph).includes('never()'), false);
});

test('exit and die bypass finally blocks', async () => {
  for (const exit of ['exit(1)', 'die()']) {
    const { graph } = await analyze(`try { ${exit}; } finally { never(); } after();`);
    assert.deepEqual(calls(graph), []);
    assert.ok(
      graph.nodes.some((node) => node.label === (exit.startsWith('exit') ? 'Exit' : 'Die'))
    );
  }
});

test('catch body failures cannot be caught by sibling catch handlers', async () => {
  const { graph } = await analyze(
    'try { work(); } catch (First $e) { handler(); } catch (\\Throwable $e) { other(); } after();'
  );
  assert.equal(
    reachable(graph, one(graph, 'handler()', 'call').id, one(graph, 'other()', 'call').id, true),
    false
  );
  assert.ok(
    reachable(graph, one(graph, 'work()', 'call').id, one(graph, 'other()', 'call').id, true)
  );
});

test('finally executes before continue 2 passes through a switch to its loop update', async () => {
  const { graph } = await analyze(
    'for (; ready(); update()) { switch ($x) { case 1: try { continue 2; } finally { cleanup(); } } tail(); }'
  );
  const jump = one(graph, 'continue 2;', 'operation');
  const cleanup = one(graph, 'cleanup()', 'call'),
    update = one(graph, 'update()', 'call');
  assert.ok(reachable(graph, jump.id, cleanup.id));
  assert.ok(reachable(graph, cleanup.id, update.id));
  assert.ok(next(graph, cleanup).some((id) => id === update.id));
});

test('declarations and first-class callables never execute nested function bodies', async () => {
  const { graph } = await analyze(
    '$callback = function () { never(); }; $arrow = fn() => alsoNever(); $callable = target(...); consume($callback, $arrow);'
  );
  assert.deepEqual(calls(graph), ['consume($callback, $arrow)']);
  assert.ok(graph.nodes.some((node) => node.label.startsWith('Create first-class callable')));
});

test('arrow functions have an implicit return and preserve their call effects', async () => {
  const adapter = new PhpLanguageAdapter();
  const request = {
    uri: 'file:///arrow.php',
    text: '<?php $f = fn($x) => compute($x);',
    documentVersion: 1,
    languageId: 'php'
  };
  const symbol = adapter.findFunction(
    request,
    new PhpSource(request.uri, request.text).positionAt(request.text.indexOf('compute'))
  )!;
  const graph = buildControlFlowGraph(await adapter.analyzeFunction(request, symbol));
  assert.deepEqual(calls(graph), ['compute($x)']);
  assert.ok(graph.nodes.some((node) => node.kind === 'return' && node.label === 'Implicit return'));
});

test('uncertain operand order keeps calls as navigation-only references', async () => {
  const { graph, result } = await analyze('return first() + second();');
  const a = one(graph, 'first()', 'call'),
    b = one(graph, 'second()', 'call');
  assert.equal(reachable(graph, a.id, b.id, true), false);
  assert.equal(reachable(graph, b.id, a.id, true), false);
  assert.ok(graph.edges.some((edge) => edge.target === a.id && edge.kind === 'reference'));
  assert.ok(result.diagnostics.some((message) => message.includes('order')));
});

test('nullsafe access skips the entire suffix including method arguments and array offsets', async () => {
  const { graph } = await analyze('$value = $x?->first(a())->second(b())[offset()]; after();');
  const guard = graph.nodes.find(
    (node) => node.kind === 'condition' && node.label.startsWith('Receiver is not null')
  )!;
  const falseTarget = next(graph, guard, 'false')[0]!;
  for (const call of graph.nodes.filter((node) => node.kind === 'call' && node.label !== 'after()'))
    assert.equal(reachable(graph, falseTarget, call.id), false);
  assert.ok(reachable(graph, falseTarget, one(graph, 'after()', 'call').id));
});

test('nullsafe argument sub-chain does not skip the containing outer call', async () => {
  const { graph } = await analyze('consume($x?->work()); after();');
  const guard = graph.nodes.find(
    (node) => node.kind === 'condition' && node.label.startsWith('Receiver is not null')
  )!;
  assert.ok(
    reachable(graph, next(graph, guard, 'false')[0]!, one(graph, 'consume($x?->work())', 'call').id)
  );
});

test('a nullsafe condition cannot become truthy on its null-result path', async () => {
  const { graph } = await analyze('if ($x?->work()) { yes(); } else { no(); }');
  const guard = graph.nodes.find(
    (node) => node.kind === 'condition' && node.label.startsWith('Receiver is not null')
  )!;
  const falseTarget = next(graph, guard, 'false')[0]!;
  assert.equal(reachable(graph, falseTarget, one(graph, 'yes()', 'call').id), false);
  assert.ok(reachable(graph, falseTarget, one(graph, 'no()', 'call').id));
});

test('generator suspension is explicit instead of a fake immediate execution trace', async () => {
  const { graph, result } = await analyze('before(); yield one(); after();');
  assert.ok(result.diagnostics.some((message) => message.includes('Generator')));
  for (const call of graph.nodes.filter((node) => node.kind === 'call'))
    assert.ok(graph.edges.some((edge) => edge.target === call.id && edge.kind === 'reference'));
});

test('nested generator declarations do not turn the outer function into a generator', async () => {
  const { graph, result } = await analyze('$f = function () { yield 1; }; normal();');
  assert.deepEqual(calls(graph), ['normal()']);
  assert.equal(
    result.diagnostics.some((message) => message.includes('Generator')),
    false
  );
});

test('unsupported goto truncates the unknown execution path instead of inventing fall-through', async () => {
  const { graph } = await analyze('goto end; never(); end: other();');
  assert.equal(calls(graph).includes('never()'), false);
  assert.equal(calls(graph).includes('other()'), false);
  assert.ok(graph.nodes.some((node) => node.kind === 'unsupported'));
});

test('static local initializers execute only on the uninitialized branch', async () => {
  const { graph } = await analyze('static $value = initialize(); after();');
  const guard = one(graph, 'Static local is initialized', 'condition');
  assert.equal(
    reachable(graph, next(graph, guard, 'true')[0]!, one(graph, 'initialize()', 'call').id),
    false
  );
});

test('plain property assignments keep RHS calls without inventing getter execution', async () => {
  const { graph, result } = await analyze('$this->value = compute(); $items[0] = 42; after();');
  assert.deepEqual(calls(graph), ['compute()', 'after()']);
  assert.equal(result.diagnostics.length, 0);
  assert.ok(
    graph.nodes.some((node) => node.kind === 'operation' && node.label.startsWith('$this->value ='))
  );
});

test('mutable dynamic assignment addresses remain explicitly opaque', async () => {
  const { graph, result } = await analyze('$items[$i] = $i++; after();');
  assert.ok(result.diagnostics.some((message) => message.includes('assignment target')));
  assert.ok(graph.nodes.some((node) => node.kind === 'unsupported'));
});

test('a literal null receiver never executes the nullsafe suffix', async () => {
  const { graph } = await analyze('null?->never(argument()); after();');
  assert.deepEqual(calls(graph), ['after()']);
});

test('multiple isset operands short circuit rather than re-reading earlier operands', async () => {
  const { graph } = await analyze('if (isset($x, $items[key()])) { yes(); } else { no(); }');
  const first = one(graph, 'Value is set and not null: $x', 'condition');
  assert.equal(
    reachable(graph, next(graph, first, 'false')[0]!, one(graph, 'key()', 'call').id),
    false
  );
});

test('invalid jump levels and absent enclosing loops are diagnosed', async () => {
  const { graph, result } = await analyze('break 0; after();');
  assert.ok(result.diagnostics.some((message) => message.includes('jump level')));
  assert.equal(calls(graph).includes('after()'), false);
  const outside = (await analyze('continue; after();')).graph;
  assert.ok(outside.diagnostics.some((item) => item.severity === 'error'));
  assert.equal(calls(outside).includes('after()'), false);
});

test('compound values retain call references without pretending to order them', async () => {
  const { graph, result } = await analyze('return [first(), second()];');
  assert.deepEqual([...calls(graph)].sort(), ['first()', 'second()']);
  assert.ok(result.diagnostics.some((message) => message.includes('Compound value')));
  for (const node of graph.nodes.filter((item) => item.kind === 'call')) {
    assert.ok(graph.edges.some((edge) => edge.target === node.id && edge.kind === 'reference'));
  }
});

test('literal null in a conditional chain cannot invoke its method or true branch', async () => {
  const { graph } = await analyze('if (null?->never()) { impossible(); } else { normal(); }');
  assert.deepEqual(calls(graph), ['normal()']);
});
