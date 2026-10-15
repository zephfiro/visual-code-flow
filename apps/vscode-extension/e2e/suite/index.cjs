const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { runPhp } = require('./php.cjs');

const EXTENSION_ID = 'zephfiro.visual-code-flow';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(assertion, timeoutMs = 10000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError;
}

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, 'Extension must be discovered by its VSIX identifier');
  await extension.activate();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-code-flow-e2e-'));
  try {
    const filename = path.join(temp, 'example.ts');
    const source = [
      'function helper(value: number): number {',
      '  return value * 2;',
      '}',
      'function main(value: number): number {',
      '  const result = helper(value);',
      '  if (result > 0) return result;',
      '  return 0;',
      '}'
    ].join('\n');
    await fs.writeFile(filename, source);
    const uri = vscode.Uri.file(filename);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(4, 12, 4, 12);
    await vscode.commands.executeCommand('visualCodeFlow.openFlow');
    const inspect = () => vscode.commands.executeCommand('visualCodeFlow.__test.inspect');
    let state;
    await retry(async () => {
      state = await inspect();
      assert.ok(state?.panel, 'Webview panel should be open');
      assert.ok(state?.graph);
    });
    assert.equal(state.graph.schemaVersion, 2);
    assert.ok(state.graph.nodes.some((node) => node.kind === 'condition'));
    const callNode = state.graph.nodes.find((node) => node.kind === 'call');
    assert.ok(callNode, 'Variable initializer call must be represented as a call node');
    await vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', {
      type: 'diagram:copy'
    });
    await retry(async () => {
      const mermaid = await vscode.env.clipboard.readText();
      assert.match(mermaid, /^flowchart TD/);
      assert.ok(mermaid.includes('helper'), 'Copied diagram contains the call label');
    });
    await vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', {
      type: 'node:expand',
      nodeId: callNode.id
    });
    await retry(async () => {
      const current = await inspect();
      assert.ok(current.expandedIds.includes(callNode.id), 'Function call expands');
      assert.ok(current.graph.nodes.some((node) => node.parentNodeId === callNode.id));
    });
    await vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', {
      type: 'node:collapse',
      nodeId: callNode.id
    });
    await retry(async () => {
      const current = await inspect();
      assert.ok(!current.expandedIds.includes(callNode.id), 'Expanded function collapses');
    });
    const root = await inspect();
    const returnNode = root.graph.nodes.find((node) => node.kind === 'return');
    assert.ok(returnNode);
    await vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', {
      type: 'node:selected',
      nodeId: returnNode.id
    });
    await retry(async () => {
      const active = vscode.window.activeTextEditor;
      assert.ok(active);
      assert.equal(active.document.uri.toString(), uri.toString());
      assert.equal(active.selection.start.line, returnNode.source.start.line);
    });
    const updated = source.replace(
      'const result = helper(value);',
      'const result = helper(value + 1);'
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(0), document.positionAt(source.length)),
      updated
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    await retry(async () => {
      const current = await inspect();
      assert.ok(!current.dirty && current.status.startsWith('Flow updated:'));
    }, 12000);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const reopened = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    reopened.selection = new vscode.Selection(4, 15, 4, 15);
    await vscode.commands.executeCommand('visualCodeFlow.openFlow');
    const final = await inspect();
    assert.ok(final.panel);
    assert.ok(final.graph.nodes.length > 0);
    await runPhp({ retry });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { run };
