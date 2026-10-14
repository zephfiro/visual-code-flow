import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const directory = path.dirname(fileURLToPath(import.meta.url));
const vsix = path.resolve(directory, '..', 'artifacts', 'visual-code-flow-0.1.0.vsix');
if (!existsSync(vsix)) throw new Error(`Missing VSIX archive: ${vsix}`);

const temporary = await mkdtemp(path.join(os.tmpdir(), 'visual-code-flow-install-'));
try {
  const binary = await downloadAndUnzipVSCode('stable');
  const proposedCli = path.join(path.dirname(binary), 'bin', 'code');
  const cli = existsSync(proposedCli) ? proposedCli : binary;
  const common = [
    '--user-data-dir',
    path.join(temporary, 'user'),
    '--extensions-dir',
    path.join(temporary, 'extensions'),
    '--no-sandbox'
  ];

  execFileSync(cli, [...common, '--install-extension', vsix, '--force'], {
    stdio: 'inherit',
    timeout: 180_000
  });
  const listing = execFileSync(cli, [...common, '--list-extensions', '--show-versions'], {
    encoding: 'utf8',
    timeout: 60_000
  });
  if (!listing.includes('zephfiro.visual-code-flow@0.1.0')) {
    throw new Error(`VSIX was not installed in the clean profile:\n${listing}`);
  }
  console.log('VSIX verified in clean VS Code profile.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
