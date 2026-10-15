import assert from 'node:assert/strict';
import { test } from 'node:test';
import Engine from 'php-parser';

function parse(text) {
  const engine = new Engine({
    parser: { version: '8.4', suppressErrors: false },
    ast: { withPositions: true, withSource: true }
  });
  return engine.parseCode(text, 'fixture.php');
}

function nodes(value, kind) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, kind));
  return [
    ...(value.kind === kind ? [value] : []),
    ...Object.entries(value)
      .filter(([key]) => key !== 'loc')
      .flatMap(([, item]) => nodes(item, kind))
  ];
}

test('parses functions, methods, closures and arrow functions without running PHP', () => {
  const ast = parse(`<?php
namespace App;
use Vendor\\Service as ImportedService;
function top(int $n): int { return $n; }
class Controller {
  public function __construct(private ImportedService $service) {}
  public static function run(): void {
    $callback = function (int $n) use ($x) { return $n + $x; };
    $arrow = fn (int $n): int => $n + 1;
  }
}
`);
  assert.equal(nodes(ast, 'function').length, 1);
  assert.equal(nodes(ast, 'method').length, 2);
  assert.equal(nodes(ast, 'closure').length, 1);
  assert.equal(nodes(ast, 'arrowfunc').length, 1);
});

test('parses the modern declaration subset needed by application fixtures', () => {
  const ast = parse(`<?php
#[Example]
readonly class Input {
  public function __construct(public string|int $value) {}
  public function nullable(?string $name): string|null { return $name; }
  public function intersection(A&B $value): A&B { return $value; }
}
enum Status: string { case Ready = 'ready'; }
trait HasWork { public function work(): void {} }
interface Contract { public function execute(): void; }
`);
  assert.equal(nodes(ast, 'class').length, 1);
  assert.equal(nodes(ast, 'enum').length, 1);
  assert.equal(nodes(ast, 'trait').length, 1);
  assert.equal(nodes(ast, 'interface').length, 1);
});

test('preserves distinct ASTs for switch, match and exception handling', () => {
  const ast = parse(`<?php
function execute($value) {
  switch ($value) { case 1: first(); case 2: second(); break; default: other(); }
  try { return match ($value) { 1, 2 => one(), default => two() }; }
  catch (First|Second $error) { throw $error; }
  finally { cleanup(); }
}
`);
  assert.equal(nodes(ast, 'switch').length, 1);
  assert.equal(nodes(ast, 'match').length, 1);
  assert.equal(nodes(ast, 'try').length, 1);
  assert.equal(nodes(ast, 'catch').length, 1);
});

test('parses loop and abrupt-control syntax needed by the CFG adapter', () => {
  const ast = parse(`<?php
function loops($items) {
  for ($i = 0; $i < 3; $i++) { foreach ($items as $item) { if ($item) break 2; } }
  while (ready()) { if (skip()) continue; work(); }
  do { tick(); } while (ready());
  exit(1);
}
`);
  for (const kind of ['for', 'foreach', 'while', 'do', 'break', 'continue', 'exit']) {
    assert.equal(nodes(ast, kind).length, 1, kind);
  }
});

test('source offsets index JavaScript UTF-16 strings with Unicode and CRLF', () => {
  const text = '<?php\r\n// emoji: 😀; accent: á\r\nfunction sample() { return "ação😀"; }\r\n';
  const ast = parse(text);
  const fn = nodes(ast, 'function')[0];
  const statement = nodes(ast, 'return')[0];
  assert.equal(fn.loc.start.offset, text.indexOf('function'));
  assert.equal(fn.loc.start.line, 3);
  assert.equal(fn.loc.start.column, 0);
  assert.equal(statement.loc.start.offset, text.indexOf('return'));
  assert.equal(
    text.slice(statement.loc.start.offset, statement.loc.end.offset),
    'return "ação😀";'
  );
});

test('incomplete PHP is rejected rather than silently publishing a partial graph', () => {
  assert.throws(() => parse('<?php function broken( {'), SyntaxError);
});

test('abstract/interface methods are distinguishable from executable bodies', () => {
  const ast = parse(
    '<?php interface A { function call(); } abstract class B { abstract function run(); }'
  );
  for (const method of nodes(ast, 'method')) assert.equal(method.body, null);
});
