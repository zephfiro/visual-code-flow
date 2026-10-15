const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function runPhp({ retry }) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'PHP integration requires the isolated test workspace');
  const root = folder.uri.fsPath;
  await fs.mkdir(path.join(root, 'app', 'Services'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'composer.json'),
    JSON.stringify({
      autoload: { 'psr-4': { 'App\\': 'app/' } },
      require: { 'laravel/framework': '^13.0' }
    })
  );
  const serviceUri = vscode.Uri.file(path.join(root, 'app', 'Services', 'Calculator.php'));
  await fs.writeFile(
    serviceUri.fsPath,
    '<?php namespace App\\Services; class Calculator { public function double(int $value): int { if ($value === 0) return 0; return $value * 2; } }'
  );
  const uri = vscode.Uri.file(path.join(root, 'app', 'Controller.php'));
  const source = [
    '<?php',
    'namespace App;',
    'use App\\Services\\Calculator;',
    'final class Controller {',
    '  public function __construct(private Calculator $calculator) {}',
    '  public function run(int $value): int {',
    '    $label = "caf\u00e9 \ud83c\udf0a";',
    '    if ($value < 0) return 0;',
    '    return $this->calculator->double($value);',
    '  }',
    '}'
  ].join('\r\n');
  await fs.writeFile(uri.fsPath, source);
  const document = await vscode.workspace.openTextDocument(uri);
  const openRoot = async () => {
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const point = document.positionAt(document.getText().indexOf('if ($value'));
    editor.selection = new vscode.Selection(point, point);
    await vscode.commands.executeCommand('visualCodeFlow.openFlow');
  };
  const inspect = () => vscode.commands.executeCommand('visualCodeFlow.__test.inspect');
  const dispatch = (message) =>
    vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', message);
  await openRoot();
  let state = await inspect();
  assert.ok(state.panel && !state.dirty, state.status);
  assert.ok(state.graph.nodes.some((node) => node.kind === 'condition'));
  let call = state.graph.nodes.find(
    (node) => node.kind === 'call' && node.label.includes('double')
  );
  assert.ok(call, 'PHP call in a return expression is represented');
  await dispatch({ type: 'node:expand', nodeId: call.id });
  state = await inspect();
  assert.ok(state.expandedIds.includes(call.id), state.status);
  assert.match(state.status, /Declared receiver type/);
  const target = state.graph.nodes.find(
    (node) =>
      node.parentNodeId === call.id &&
      node.kind === 'return' &&
      node.source?.uri === serviceUri.toString()
  );
  assert.ok(target, 'PSR-4 target graph is navigable');
  await dispatch({ type: 'node:selected', nodeId: target.id });
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), serviceUri.toString());
  assert.equal(
    vscode.window.activeTextEditor.selection.start.character,
    target.source.start.character
  );

  await dispatch({ type: 'diagram:copy' });
  assert.match(await vscode.env.clipboard.readText(), /^flowchart TD/);
  const output = vscode.Uri.file(path.join(root, 'flow.mmd'));
  await vscode.commands.executeCommand(
    'visualCodeFlow.__test.chooseSaveDestination',
    output.toString()
  );
  await dispatch({ type: 'diagram:save' });
  assert.match(await fs.readFile(output.fsPath, 'utf8'), /^flowchart TD/);

  await vscode.commands.executeCommand('visualCodeFlow.__test.flushSession');
  await openRoot();
  state = await inspect();
  assert.ok(state.expandedIds.includes(call.id), 'Unchanged PHP session restores its expansion');
  await dispatch({ type: 'node:collapse', nodeId: call.id });
  assert.equal((await inspect()).expandedIds.length, 0);

  const config = vscode.workspace.getConfiguration('visualCodeFlow');
  await config.update('autoRefresh', false, vscode.ConfigurationTarget.Workspace);
  const invalid = new vscode.WorkspaceEdit();
  invalid.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    '<?php class {'
  );
  assert.ok(await vscode.workspace.applyEdit(invalid));
  assert.equal((await inspect()).dirty, true);
  await vscode.env.clipboard.writeText('stale-export-blocked');
  await dispatch({ type: 'diagram:copy' });
  assert.equal(await vscode.env.clipboard.readText(), 'stale-export-blocked');
  await vscode.commands.executeCommand('visualCodeFlow.openFlow');
  assert.equal((await inspect()).dirty, true, 'Invalid syntax retains the dirty last graph');
  const valid = new vscode.WorkspaceEdit();
  valid.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    source
  );
  assert.ok(await vscode.workspace.applyEdit(valid));
  await openRoot();
  assert.equal((await inspect()).dirty, false, 'An unsaved valid PHP buffer can be analyzed');
  await config.update('autoRefresh', true, vscode.ConfigurationTarget.Workspace);

  // A Composer edit invalidates a session even when root PHP text is unchanged.
  state = await inspect();
  call = state.graph.nodes.find((node) => node.kind === 'call' && node.label.includes('double'));
  await dispatch({ type: 'node:expand', nodeId: call.id });
  await vscode.commands.executeCommand('visualCodeFlow.__test.flushSession');
  const composer = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(root, 'composer.json'))
  );
  const metadata = new vscode.WorkspaceEdit();
  metadata.replace(
    composer.uri,
    new vscode.Range(composer.positionAt(0), composer.positionAt(composer.getText().length)),
    '{"autoload":{"psr-4":{"App\\\\":"elsewhere/"}}}'
  );
  await vscode.workspace.applyEdit(metadata);
  await retry(async () => {
    const current = await inspect();
    assert.equal(current.dirty, false);
    assert.equal(current.expandedIds.length, 0);
  });
  await openRoot();
  await dispatch({ type: 'node:expand', nodeId: call.id });
  assert.equal(
    (await inspect()).expandedIds.length,
    0,
    'Changed PSR-4 mapping does not reuse stale destination'
  );

  const jsUri = vscode.Uri.file(path.join(root, 'example.js'));
  await fs.writeFile(jsUri.fsPath, 'function jsExample(value) { if (value) return 1; return 0; }');
  const js = await vscode.workspace.openTextDocument(jsUri);
  const editor = await vscode.window.showTextDocument(js, vscode.ViewColumn.One);
  editor.selection = new vscode.Selection(0, 30, 0, 30);
  await vscode.commands.executeCommand('visualCodeFlow.openFlow');
  state = await inspect();
  assert.match(state.status, /jsExample/);
  assert.ok(
    state.graph.nodes.every((node) => !node.source || node.source.uri === jsUri.toString())
  );

  const blade = vscode.Uri.file(path.join(root, 'view.blade.php'));
  await fs.writeFile(blade.fsPath, '<?php function nope() { return 1; } ?>');
  const bladeDocument = await vscode.workspace.openTextDocument(blade);
  await vscode.window.showTextDocument(bladeDocument);
  await vscode.commands.executeCommand('visualCodeFlow.openFlow');
  assert.match((await inspect()).status, /Blade templates are not supported/);
}

module.exports = { runPhp };
