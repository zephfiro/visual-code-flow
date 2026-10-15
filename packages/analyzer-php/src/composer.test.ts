import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classFileCandidates,
  parseComposerMap,
  projectFileUri,
  relativeProjectPath
} from './composer.js';

test('Composer PSR-4 paths, dev mappings and explicit files are data only', () => {
  const map = parseComposerMap(
    'file:///project',
    JSON.stringify({
      autoload: { 'psr-4': { 'App\\': ['app/', 'src/'] }, files: ['app/helpers.php'] },
      'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
      require: { 'laravel/framework': '^13.0' }
    })
  );
  assert.deepEqual(classFileCandidates(map, 'App\\Services\\S'), [
    'file:///project/app/Services/S.php',
    'file:///project/src/Services/S.php'
  ]);
  assert.equal(map.laravel, true);
  assert.equal(map.files[0], 'file:///project/app/helpers.php');
  assert.equal(classFileCandidates(map, 'Tests\\Sample').length, 1);
  assert.equal(
    classFileCandidates(
      parseComposerMap(
        'file:///project',
        '{"autoload-dev":{"psr-4":{"Tests\\\\":"tests/"}}}',
        false
      ),
      'Tests\\Sample'
    ).length,
    0
  );
});

test('Composer rejects traversal, encoded separators, secrets and generated paths', () => {
  for (const path of [
    '../outside',
    '/etc',
    'C:/app',
    'app/%2e%2e',
    '.env',
    '.ENV.local',
    'vendor/lib',
    'storage/logs',
    'bootstrap/cache',
    'https://example.com'
  ])
    assert.equal(projectFileUri('file:///project/', path), undefined, path);
  assert.equal(relativeProjectPath('file:///project', 'file:///project-other/file.php'), undefined);
  assert.equal(
    relativeProjectPath('file:///project', 'file:///project/app%2Fhidden.php'),
    undefined
  );
  assert.equal(
    parseComposerMap('file:///project', 'secret invalid').diagnostics[0],
    'Invalid Composer metadata.'
  );
});

test('invalid or truncated mappings cannot masquerade as a complete index', () => {
  const map = parseComposerMap(
    'file:///project',
    JSON.stringify({ autoload: { 'psr-4': { 'App\\': ['app/', '../outside'] } } })
  );
  assert.equal(map.incomplete, true);
  const paths = Array.from({ length: 257 }, (_, index) => `src${index}/`);
  assert.equal(
    parseComposerMap(
      'file:///project',
      JSON.stringify({ autoload: { 'psr-4': { 'App\\': paths } } })
    ).incomplete,
    true
  );
});

test('safe URI mapping supports remote authorities and Unicode filenames', () => {
  const root = 'vscode-remote://ssh-remote+dev/work/project/';
  const uri = projectFileUri(root, 'app/Caf\u00e9.php')!;
  assert.equal(relativeProjectPath(root, uri), 'app/Caf\u00e9.php');
  assert.equal(
    relativeProjectPath(root, 'vscode-remote://ssh-remote+other/work/project/app/C.php'),
    undefined
  );
});

test('malformed autoload sections and unsupported competing maps fail closed', () => {
  for (const autoload of [
    null,
    [],
    'app/',
    { 'psr-4': [] },
    { files: 'app/helpers.php' },
    { classmap: ['app/'] },
    { 'psr-0': { Legacy: 'legacy/' } }
  ]) {
    assert.equal(
      parseComposerMap('file:///project/', JSON.stringify({ autoload })).incomplete,
      true
    );
  }
});
