import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisRequest } from '@visual-code-flow/shared';
import { PhpLanguageAdapter } from './adapter.js';
import { PhpAnalysisError, PhpDocumentCache } from './document.js';
import { PhpSource } from './source.js';

const request = (
  text: string,
  uri = 'file:///example.php',
  documentVersion = 1
): AnalysisRequest => ({ uri, languageId: 'php', text, documentVersion });
const at = (input: AnalysisRequest, needle: string) => {
  const offset = input.text.indexOf(needle);
  assert.ok(offset >= 0, `Fixture marker missing: ${needle}`);
  return new PhpSource(input.uri, input.text).positionAt(offset);
};

test('selects the smallest function including nested closures and declaration headers', () => {
  const adapter = new PhpLanguageAdapter();
  const input = request(`<?php namespace App;
class Demo {
  public function run() {
    $callback = function ($value) { return $value + 1; };
    return $callback(1);
  }
}
function outer() { function inner() { return 2; } return inner(); }
`);
  assert.equal(adapter.findFunction(input, at(input, 'public function'))?.name, 'App\\Demo::run');
  assert.equal(adapter.findFunction(input, at(input, 'return $value'))?.name, '$callback');
  assert.equal(adapter.findFunction(input, at(input, 'return $callback'))?.name, 'App\\Demo::run');
  assert.equal(adapter.findFunction(input, at(input, 'return 2'))?.name, 'App\\inner');
  assert.equal(adapter.findFunction(input, at(input, 'return inner'))?.name, 'App\\outer');
  assert.equal(adapter.findFunction(input, at(input, 'namespace')), undefined);
});

test('discovers constructors, static methods, trait methods and arrow expression bodies', () => {
  const adapter = new PhpLanguageAdapter();
  const input = request(`<?php
trait Work { public function work() {} }
class Demo {
  public function __construct(private string $name) {}
  public static function build() { $double = fn(int $n): int => $n * 2; }
}
`);
  const document = adapter.parseDocument(input);
  assert.equal(document.functions.length, 4);
  const fn = document.functions.find((item) => item.node.kind === 'arrowfunc')!;
  assert.equal(fn.descriptor.name, '$double');
  assert.equal(document.source.slice(fn.body), '$n * 2');
  assert.equal(fn.ownerName, 'Demo');
  assert.ok(fn.enclosingSymbolId?.includes('Demo::build'));
});

test('named nested functions do not inherit a class receiver context', () => {
  const adapter = new PhpLanguageAdapter();
  const document = adapter.parseDocument(
    request('<?php class A { function method() { function inner() {} } }')
  );
  assert.equal(document.functions.find((fn) => fn.descriptor.name === 'inner')?.owner, undefined);
});

test('abstract/interface declarations are not executable functions', () => {
  const adapter = new PhpLanguageAdapter();
  const input = request(
    '<?php interface A { function missing(); } abstract class B { abstract function run(); function real() {} }'
  );
  assert.deepEqual(
    adapter.parseDocument(input).functions.map((fn) => fn.descriptor.name),
    ['B::real']
  );
  assert.equal(adapter.findFunctionDefinition(input, at(input, 'missing')), undefined);
  assert.equal(adapter.findFunction(input, at(input, 'run();')), undefined);
});

test('precise definitions support variable-bound arrows but never guess from body positions', () => {
  const adapter = new PhpLanguageAdapter();
  const input = request('<?php function root() { $double = fn($n) => $n * 2; return $double(1); }');
  assert.equal(adapter.findFunctionDefinition(input, at(input, 'root'))?.name, 'root');
  assert.equal(adapter.findFunctionDefinition(input, at(input, '$double ='))?.name, '$double');
  assert.equal(adapter.findFunctionDefinition(input, at(input, 'return')), undefined);
});

test('ranges preserve Unicode, UTF-16 columns, CRLF and non-saved buffers', () => {
  const adapter = new PhpLanguageAdapter();
  const input = request(
    '<?php\r\n// \u{1f600} a\u00e7\u00e3o\r\nfunction read() { $x = "\u{1f600}"; return $x; }\r\n',
    'untitled:Untitled-1'
  );
  const fn = adapter.findFunction(input, at(input, 'return'))!;
  const source = new PhpSource(input.uri, input.text);
  assert.equal(fn.location.start.line, 2);
  assert.equal(source.offsetAt(fn.body.start), input.text.indexOf('{'));
  assert.equal(source.offsetAt(fn.location.end), input.text.lastIndexOf('}') + 1);
  assert.equal(adapter.findFunction(input, at(input, 'return'))?.symbolId, fn.symbolId);
});

test('coordinates handle LF/CRLF/CR, empty lines and invalid editor positions', () => {
  const source = new PhpSource('test', 'a\r\nb\nc\r\n');
  for (const offset of [0, 1, 3, 4, 5, 6, 8]) {
    assert.equal(source.offsetAt(source.positionAt(offset)), offset);
  }
  assert.equal(source.offsetAt({ line: 0, character: 9 }), undefined);
  assert.equal(source.offsetAt({ line: -1, character: 0 }), undefined);
  assert.equal(source.offsetAt({ line: 0, character: 0.5 }), undefined);
  assert.throws(() => source.positionAt(-1), RangeError);
});

test('invalid syntax errors never include source fragments or parser causes', () => {
  const adapter = new PhpLanguageAdapter();
  assert.throws(
    () => adapter.parseDocument(request('<?php function secret_token_123( {')),
    (error) => {
      assert.ok(error instanceof PhpAnalysisError);
      assert.equal(error.code, 'invalid-syntax');
      assert.ok(!String(error).includes('secret_token_123'));
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test('LRU caching checks text as well as URI/version and preserves valid snapshots on errors', () => {
  const cache = new PhpDocumentCache({ maxCacheEntries: 2 });
  const first = request('<?php function one() {}');
  const document = cache.get(first);
  assert.equal(cache.get({ ...first }), document);
  const changed = request('<?php function two() {}');
  assert.notEqual(cache.get(changed), document);
  assert.throws(() => cache.get(request('<?php function broken(', first.uri, 2)));
  assert.equal(cache.get(changed).functions[0]?.descriptor.name, 'two');
  cache.get(request('<?php', 'file:///two.php'));
  cache.get(request('<?php', 'file:///three.php'));
  assert.equal(cache.size, 2);
  cache.invalidate('file:///three.php');
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('source, node and depth limits reject work rather than returning a partial document', () => {
  assert.throws(
    () => new PhpDocumentCache({ maxSourceLength: 10 }).get(request('<?php function large() {}')),
    /limit/
  );
  assert.throws(
    () =>
      new PhpDocumentCache({ maxNodes: 2 }).get(request('<?php function nodes() { return 1; }')),
    /limit/
  );
  assert.throws(
    () =>
      new PhpDocumentCache({ maxDepth: 2 }).get(
        request('<?php function depth() { return [[[1]]]; }')
      ),
    /limit/
  );
  assert.throws(() => new PhpDocumentCache({ maxCacheEntries: 0 }), RangeError);
  assert.throws(() => new PhpDocumentCache({ maxDepth: 99999 }), RangeError);
});

test('cancellation precedes parsing and statement analysis', async () => {
  const adapter = new PhpLanguageAdapter();
  const input = request('<?php function root() {}');
  assert.throws(
    () => adapter.parseDocument(request('invalid'), { isCancellationRequested: true }),
    /cancelled/
  );
  const symbol = adapter.findFunction(input, at(input, 'root'))!;
  await assert.rejects(
    adapter.analyzeFunction(input, symbol, { isCancellationRequested: true }),
    /cancelled/
  );
});

test('stale and foreign symbols cannot be analyzed as a different function', async () => {
  const adapter = new PhpLanguageAdapter();
  const first = request('<?php function root() {}');
  const symbol = adapter.findFunction(first, at(first, 'root'))!;
  await assert.rejects(
    adapter.analyzeFunction(request('<?php function other() {}'), symbol),
    /no longer/
  );
  await assert.rejects(
    adapter.analyzeFunction(request(first.text, 'file:///other.php'), symbol),
    /no longer/
  );
});

test('discovery never pretends that unimplemented PHP statements have a correct CFG', async () => {
  const adapter = new PhpLanguageAdapter();
  const input = request('<?php function root() { return 1; }');
  const symbol = adapter.findFunction(input, at(input, 'return'))!;
  const result = await adapter.analyzeFunction(input, symbol);
  assert.equal(result.statements[0]?.kind, 'unsupported');
  assert.ok(result.diagnostics.length > 0);
});

test('Blade and non-PHP documents are explicitly rejected', () => {
  const adapter = new PhpLanguageAdapter();
  assert.throws(
    () => adapter.parseDocument(request('<?php', 'file:///page.blade.php')),
    /plain PHP/
  );
  assert.throws(
    () => adapter.parseDocument({ ...request('function x() {}'), languageId: 'javascript' }),
    /plain PHP/
  );
});

test('standalone CR is a line break and supplementary characters occupy two columns', () => {
  const text = '<?php\rfunction run() { $x = "\u{1f600}"; return $x; }';
  const input = request(text);
  const source = new PhpSource(input.uri, text);
  const position = source.positionAt(text.indexOf('return'));
  assert.equal(position.line, 1);
  assert.equal(position.character, text.slice(text.indexOf('function')).indexOf('return'));
  assert.equal(source.offsetAt(position), text.indexOf('return'));
  assert.equal(new PhpLanguageAdapter().findFunction(input, position)?.name, 'run');
});

test('document cache snapshots cannot be changed by mutating the request object', () => {
  const cache = new PhpDocumentCache();
  const input = { ...request('<?php function original() {}') };
  const document = cache.get(input);
  input.text = '<?php function changed() {}';
  assert.equal(document.request.text, '<?php function original() {}');
  assert.notEqual(cache.get(input), document);
});
