import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const directory = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(directory, '..');
const extensionTestsPath = path.join(directory, 'suite', 'index.cjs');

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
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
}
