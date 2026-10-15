import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhpLanguageAdapter } from './adapter.js';
import { parseComposerMap } from './composer.js';
import { PhpProjectIndex, type PhpFileHost } from './project.js';
import { phpCalleePosition, resolvePhpCall } from './symbols.js';
import type { AnalysisRequest } from '@visual-code-flow/shared';

const adapter = new PhpLanguageAdapter();
const request = (text: string, uri = 'file:///project/app/Test.php'): AnalysisRequest => ({
  uri,
  text: `<?php ${text}`,
  languageId: 'php',
  documentVersion: 1
});
function fixture(text: string, call: string, occurrence = 0) {
  const doc = adapter.parseDocument(request(text));
  const matches = [];
  let start = doc.request.text.indexOf(call);
  while (start >= 0) {
    const end = start + call.length;
    // Ignore textual matches in function declarations. Parentheses may be
    // excluded from AST locations; production source intervals stay unchanged.
    const candidates = doc.nodes
      .filter((item) => {
        if (!['call', 'new'].includes(item.kind)) return false;
        const [a, rawEnd] = doc.source.offsets(item);
        const b = doc.request.text[rawEnd - 1] === ';' ? rawEnd - 1 : rawEnd;
        return a >= start && b <= end;
      })
      .sort((a, b) => {
        const left = doc.source.offsets(a);
        const right = doc.source.offsets(b);
        return right[1] - right[0] - (left[1] - left[0]);
      });
    if (candidates[0]) matches.push(candidates[0]);
    start = doc.request.text.indexOf(call, start + 1);
  }
  const node = matches[occurrence];
  assert.ok(node, `Missing test call: ${call}`);
  return { doc, source: doc.source.span(node) };
}
function resolvedName(text: string, call: string): string | undefined {
  const { doc, source } = fixture(text, call);
  const result = resolvePhpCall(doc, source);
  return doc.functions.find((fn) => fn.descriptor.symbolId === result.targets[0]?.symbolId)
    ?.descriptor.name;
}
function reason(text: string, call: string) {
  const { doc, source } = fixture(text, call);
  return resolvePhpCall(doc, source).reason;
}

test('namespace class alias and typed receiver retain evidence', () => {
  const { doc, source } = fixture(
    'namespace Domain { class Service { function save() {} } } namespace App { use Domain\\Service as S; function run(S $s) { $s->save(); } }',
    '$s->save()'
  );
  const result = resolvePhpCall(doc, source);
  assert.equal(result.targets.length, 1);
  assert.match(result.targets[0]!.evidence!, /Declared receiver type/);
  assert.ok(result.targets[0]!.symbolId.includes('Domain\\Service::save'));
  const position = phpCalleePosition(doc, source)!;
  assert.equal(
    doc.request.text.slice(doc.source.offsetAt(position)!, doc.source.offsetAt(position)! + 4),
    'save'
  );
});

test('grouped function imports and namespace fallback', () => {
  assert.equal(
    resolvedName(
      'namespace A { function helper() {} } namespace B { use A\\{function helper as h}; function run() { h(); } }',
      'h()'
    ),
    'A\\helper'
  );
  assert.equal(
    resolvedName(
      'namespace { function helper() {} } namespace A { function run() { helper(); } }',
      'helper()'
    ),
    'helper'
  );
  assert.equal(
    resolvedName(
      'namespace { function helper() {} } namespace A { function helper() {} function run() { helper(); } }',
      'helper()'
    ),
    'A\\helper'
  );
});

test('imports do not leak across repeated namespace blocks', () => {
  assert.equal(
    resolvedName(
      'namespace One { class S { static function run() {} } } namespace Two { class S { static function run() {} } } namespace App { use One\\S; function first() { S::run(); } } namespace App { use Two\\S; function second() { S::run(); } }',
      'S::run()'
    ),
    'One\\S::run'
  );
});

test('self, parent and literal constructor method targets', () => {
  assert.equal(
    resolvedName(
      'class A { static function save() {} } class B extends A { function run() { parent::save(); } }',
      'parent::save()'
    ),
    'A::save'
  );
  assert.equal(
    resolvedName(
      'class A { static function save() {} function run() { self::save(); } }',
      'self::save()'
    ),
    'A::save'
  );
  assert.equal(
    resolvedName(
      'class A { function save() {} } function run() { (new A())->save(); }',
      '(new A())->save()'
    ),
    'A::save'
  );
});

test('promoted and ordinary property types identify declarations', () => {
  assert.equal(
    resolvedName(
      'class S { function save() {} } class C { function __construct(private S $s) {} function run() { $this->s->save(); } }',
      '$this->s->save()'
    ),
    'S::save'
  );
  assert.equal(
    resolvedName(
      'class S { function save() {} } class C { private S $s; function run() { $this->s->save(); } }',
      '$this->s->save()'
    ),
    'S::save'
  );
});

test('interfaces, union receivers and invalid static calls stay unresolved', () => {
  assert.equal(
    reason('interface S { function save(); } function run(S $s) { $s->save(); }', '$s->save()'),
    'unsupported'
  );
  assert.equal(
    reason(
      'class A { function save() {} } class B { function save() {} } function run(A|B $s) { $s->save(); }',
      '$s->save()'
    ),
    'ambiguous'
  );
  assert.equal(
    reason('class S { function save() {} } function run() { S::save(); }', 'S::save()'),
    'unsupported'
  );
});

test('dynamic class variables and late static binding are never guessed', () => {
  assert.equal(
    reason(
      'class S { static function save() {} function run($self) { $self::save(); } }',
      '$self::save()'
    ),
    'dynamic'
  );
  assert.equal(
    reason('class S { static function save() {} } function run($S) { $S::save(); }', '$S::save()'),
    'dynamic'
  );
  assert.equal(
    reason('class S { function __construct() {} } function run($S) { new $S(); }', 'new $S()'),
    'dynamic'
  );
  assert.equal(
    reason(
      'class S { static function save() {} function run() { static::save(); } }',
      'static::save()'
    ),
    'dynamic'
  );
});

test('reassigned or potentially by-reference-mutated parameters lose their type hint', () => {
  assert.equal(
    reason(
      'class S { function save() {} } function run(S $s) { $s = null; $s->save(); }',
      '$s->save()'
    ),
    'dynamic'
  );
  assert.equal(
    reason(
      'class S { function save() {} } function run(S $s) { change($s); $s->save(); }',
      '$s->save()'
    ),
    'dynamic'
  );
});

test('private and protected access is checked', () => {
  assert.equal(
    reason(
      'class S { private function save() {} } function run(S $s) { $s->save(); }',
      '$s->save()'
    ),
    'unsupported'
  );
  assert.equal(
    resolvedName(
      'class S { private function save() {} function run() { $this->save(); } }',
      '$this->save()'
    ),
    'S::save'
  );
  assert.equal(
    resolvedName(
      'class A { protected function save() {} } class B extends A { function run() { $this->save(); } }',
      '$this->save()'
    ),
    'A::save'
  );
});

test('trait implementations, conflicts and adaptations are distinguished', () => {
  assert.equal(
    resolvedName(
      'trait T { function save() {} } class C { use T; function run() { $this->save(); } }',
      '$this->save()'
    ),
    'T::save'
  );
  assert.equal(
    reason(
      'trait A { function save() {} } trait B { function save() {} } class C { use A, B; function run() { $this->save(); } }',
      '$this->save()'
    ),
    'ambiguous'
  );
  assert.equal(
    reason(
      'trait T { function save() {} } class C { use T { save as other; } function run() { $this->other(); } }',
      '$this->other()'
    ),
    'unsupported'
  );
});

test('magic dispatch and conditional declarations are not ordinary targets', () => {
  assert.equal(
    reason(
      'class S { function __call($name, $args) {} } function run(S $s) { $s->save(); }',
      '$s->save()'
    ),
    'dynamic'
  );
  assert.equal(
    reason('if (true) { function helper() {} } function run() { helper(); }', 'helper()'),
    'dynamic'
  );
});

test('duplicate source declarations cannot produce an arbitrary destination', () => {
  const { doc, source } = fixture(
    'class S { function save() {} } function run(S $s) { $s->save(); }',
    '$s->save()'
  );
  const duplicate = adapter.parseDocument(
    request('class S { function save() {} }', 'file:///project/app/Other.php')
  );
  assert.equal(resolvePhpCall(doc, source, [doc, duplicate]).reason, 'ambiguous');
});

test('static closures cannot recover this from a class owner', () => {
  assert.equal(
    reason(
      'class S { function save() {} static function run() { $f = function () { $this->save(); }; } }',
      '$this->save()'
    ),
    'dynamic'
  );
});

function projectFixture(root = 'file:///project/') {
  const files = new Map<string, AnalysisRequest>();
  const reads: string[] = [];
  const links = new Set<string>();
  const host: PhpFileHost = {
    async stat(uri) {
      if (links.has(uri.replace(/\/$/, ''))) return 'symlink';
      if (files.has(uri)) return 'file';
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      return uri === root || [...files.keys()].some((file) => file.startsWith(prefix))
        ? 'directory'
        : 'missing';
    },
    async read(uri) {
      reads.push(uri);
      return files.get(uri);
    }
  };
  const text =
    'namespace App; use App\\Services\\S; class Controller { function run(S $s) { $s->save(); } }';
  const caller = adapter.parseDocument(request(text, `${root}app/Controller.php`));
  files.set(caller.request.uri, caller.request);
  files.set(
    `${root}app/Services/S.php`,
    request('namespace App\\Services; class S { function save() {} }', `${root}app/Services/S.php`)
  );
  const call = caller.nodes.find((node) => node.kind === 'call')!;
  const source = caller.source.span(call);
  const map = parseComposerMap(root, '{"autoload":{"psr-4":{"App\\\\":"app/"}}}');
  return { files, reads, links, host, caller, source, map };
}

test('project resolution loads only PSR-4 candidates without runtime dependencies', async () => {
  const f = projectFixture();
  const index = new PhpProjectIndex(f.map, f.host);
  const result = await index.resolve(f.caller, f.source);
  assert.equal(result.targets[0]?.definition.uri, 'file:///project/app/Services/S.php');
  assert.deepEqual(f.reads, ['file:///project/app/Services/S.php']);
});

test('same namespace in separate Composer roots remains isolated', async () => {
  const a = projectFixture('file:///one/');
  const b = projectFixture('file:///two/');
  assert.equal(
    (await new PhpProjectIndex(a.map, a.host).resolve(a.caller, a.source)).targets[0]?.definition
      .uri,
    'file:///one/app/Services/S.php'
  );
  assert.equal(
    (await new PhpProjectIndex(b.map, b.host).resolve(b.caller, b.source)).targets[0]?.definition
      .uri,
    'file:///two/app/Services/S.php'
  );
});

test('invalidation observes changed declarations and removes stale targets', async () => {
  const f = projectFixture();
  const index = new PhpProjectIndex(f.map, f.host);
  assert.equal((await index.resolve(f.caller, f.source)).targets.length, 1);
  const uri = 'file:///project/app/Services/S.php';
  f.files.set(uri, request('namespace App\\Services; class S {}', uri));
  index.invalidate(uri);
  assert.equal((await index.resolve(f.caller, f.source)).targets.length, 0);
});

test('symlinks, parser failures and size limits fail closed', async () => {
  const f = projectFixture();
  f.links.add('file:///project/app/Services');
  assert.equal(
    (await new PhpProjectIndex(f.map, f.host).resolve(f.caller, f.source)).reason,
    'unsupported'
  );
  assert.equal(f.reads.length, 0);
  f.links.clear();
  assert.equal(
    (await new PhpProjectIndex(f.map, f.host, { maxDocuments: 1 }).resolve(f.caller, f.source))
      .reason,
    'unsupported'
  );
  const uri = 'file:///project/app/Services/S.php';
  f.files.set(uri, request('namespace App\\Services; class S {', uri));
  assert.equal(
    (await new PhpProjectIndex(f.map, f.host).resolve(f.caller, f.source)).reason,
    'unsupported'
  );
});

test('a generation change cancels a pending resolution', async () => {
  const f = projectFixture();
  const index = new PhpProjectIndex(f.map, {
    ...f.host,
    async read(uri) {
      index.invalidate();
      return f.files.get(uri);
    }
  });
  await assert.rejects(
    index.resolve(f.caller, f.source),
    (error: unknown) => error instanceof Error && error.message === 'PHP analysis was cancelled.'
  );
});

test('private properties do not resolve from a child class', () => {
  assert.equal(
    reason(
      'class S { function save() {} } class A { private S $s; } class B extends A { function run() { $this->s->save(); } }',
      '$this->s->save()'
    ),
    'dynamic'
  );
});

test('the second repeated namespace uses its own import table', () => {
  const { doc, source } = fixture(
    'namespace One { class S { static function run() {} } } namespace Two { class S { static function run() {} } } namespace App { use One\\S; function first() { S::run(); } } namespace App { use Two\\S; function second() { S::run(); } }',
    'S::run()',
    1
  );
  assert.ok(resolvePhpCall(doc, source).targets[0]?.symbolId.includes('Two\\S::run'));
});

test('missing and duplicate PSR-4 class files remain explicit', async () => {
  const f = projectFixture();
  const uri = 'file:///project/app/Services/S.php';
  const original = f.files.get(uri)!;
  f.files.delete(uri);
  assert.equal(
    (await new PhpProjectIndex(f.map, f.host).resolve(f.caller, f.source)).reason,
    'external'
  );
  f.files.set(uri, original);
  const duplicateUri = 'file:///project/src/Services/S.php';
  f.files.set(duplicateUri, { ...original, uri: duplicateUri });
  const map = parseComposerMap(
    f.map.root,
    JSON.stringify({ autoload: { 'psr-4': { 'App\\': ['app/', 'src/'] } } })
  );
  assert.equal(
    (await new PhpProjectIndex(map, f.host).resolve(f.caller, f.source)).reason,
    'ambiguous'
  );
});

test('adapter exposes local targets and rejects foreign or cancelled spans', async () => {
  const { doc, source } = fixture('function helper() {} function run() { helper(); }', 'helper()');
  assert.equal((await adapter.resolveCall(doc.request, source)).targets.length, 1);
  assert.ok(adapter.findCallTargetPosition(doc.request, source));
  assert.equal(
    (await adapter.resolveCall(doc.request, { ...source, uri: 'file:///foreign.php' })).targets
      .length,
    0
  );
  await assert.rejects(adapter.resolveCall(doc.request, source, { isCancellationRequested: true }));
});
