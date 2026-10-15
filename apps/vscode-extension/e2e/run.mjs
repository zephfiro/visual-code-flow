import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = await mkdtemp(path.join(os.tmpdir(), 'visual-code-flow-workspace-'));
try {
  await runTests({
    extensionDevelopmentPath: path.resolve(directory, '..'),
    extensionTestsPath: path.join(directory, 'suite', 'index.cjs'),
    launchArgs: [
      workspace,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-gpu',
      '--no-sandbox'
    ]
  });
} catch (error) {
  console.error('VS Code integration tests failed:', error);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
