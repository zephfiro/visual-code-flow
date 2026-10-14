import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const archive = path.resolve('apps/vscode-extension/artifacts/visual-code-flow-0.1.0.vsix');
assert.ok(existsSync(archive), 'VSIX must be generated before verification');

const contents = execFileSync('unzip', ['-Z', '-1', archive], {
  encoding: 'utf8'
}).trim().split('\n');
const required = [
  'extension/package.json',
  'extension/README.md',
  'extension/LICENSE',
  'extension/dist/extension.cjs',
  'extension/media/webview.js',
  'extension/media/webview.css'
];
for (const name of required) {
  assert.ok(contents.includes(name), `Required VSIX entry missing: ${name}`);
}
assert.ok(
  !contents.some((entry) => entry.startsWith('extension/node_modules/')),
  'Package must be self-contained without workspace symlinks'
);
assert.ok(
  !contents.some((entry) => entry.startsWith('extension/src/')),
  'TypeScript source must not be published'
);

const manifest = JSON.parse(
  execFileSync('unzip', ['-p', archive, 'extension/package.json'], {
    encoding: 'utf8'
  })
);
assert.equal(manifest.publisher, 'zephfiro');
assert.equal(manifest.name, 'visual-code-flow');
assert.equal(manifest.version, '0.1.0');
assert.equal(manifest.main, './dist/extension.cjs');

console.log(`VSIX verified: ${contents.length} entries; ${required.length} required entries present.`);
