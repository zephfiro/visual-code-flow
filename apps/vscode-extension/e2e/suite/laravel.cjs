const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function runLaravel({ retry }) {
  const root = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'laravel-app');
  const write = async (relative, text) => {
    const filename = path.join(root, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, text);
    return vscode.Uri.file(filename);
  };
  await write(
    'composer.json',
    JSON.stringify({
      require: { 'laravel/framework': '^13.0' },
      autoload: { 'psr-4': { 'Demo\\': ['app/', 'overrides/'] } }
    })
  );
  await write(
    'bootstrap/app.php',
    "<?php use Illuminate\\Foundation\\Application; return Application::configure(basePath: dirname(__DIR__))->withRouting(web: __DIR__.'/../routes/web.php');"
  );
  await write('bootstrap/providers.php', '<?php return [];');
  const serviceUri = await write(
    'app/Calculator.php',
    '<?php namespace Demo; class Calculator { public function total(int $value) { return $value * 2; } }'
  );
  const controllerUri = await write(
    'app/Controller.php',
    '<?php namespace Demo; class Controller { public function __construct(private Calculator $calculator) {} public function index() { return $this->calculator->total(2); } }'
  );
  await write(
    'app/Duplicate.php',
    '<?php namespace Demo; class Duplicate { public function index() { return 1; } }'
  );
  await write(
    'overrides/Duplicate.php',
    '<?php namespace Demo; class Duplicate { public function index() { return 2; } }'
  );
  const routeText = [
    '<?php',
    'use Illuminate\\Support\\Facades\\Route;',
    "Route::prefix('ops')->middleware('audit')->group(function () { Route::get('/orders', [\\Demo\\Controller::class, 'index'])->name('orders.index'); });",
    "Route::get('/closure', fn()=>42)->name('closure');",
    "Route::get('/missing', [\\Demo\\Missing::class, 'index'])->name('missing');",
    "Route::get('/duplicate', [\\Demo\\Duplicate::class, 'index'])->name('duplicate');"
  ].join('\r\n');
  const routesUri = await write('routes/web.php', routeText);
  const routeDocument = await vscode.workspace.openTextDocument(routesUri);
  const inspect = () => vscode.commands.executeCommand('visualCodeFlow.__test.inspect');
  const dispatch = (message) =>
    vscode.commands.executeCommand('visualCodeFlow.__test.dispatch', message);
  const select = async (name) => {
    await vscode.window.showTextDocument(routeDocument, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('visualCodeFlow.__test.chooseRoute', name);
    await vscode.commands.executeCommand('visualCodeFlow.openLaravelRoute');
  };
  await retry(async () => {
    await select('orders.index');
    const state = await inspect();
    assert.match(state.status, /Route orders.index -> handler/);
    assert.equal(state.routeOrigin.uri, routesUri.toString());
  });
  let state = await inspect();
  assert.ok(state.graph.nodes.some((node) => node.source?.uri === controllerUri.toString()));
  assert.match(state.status, /Navigation only/);
  const call = state.graph.nodes.find(
    (node) => node.kind === 'call' && node.label.includes('total')
  );
  assert.ok(call);
  await dispatch({ type: 'node:expand', nodeId: call.id });
  state = await inspect();
  assert.ok(state.expandedIds.includes(call.id), state.status);
  assert.ok(state.graph.nodes.some((node) => node.source?.uri === serviceUri.toString()));
  await dispatch({ type: 'diagram:copy' });
  assert.match(await vscode.env.clipboard.readText(), /^flowchart TD/);
  await vscode.commands.executeCommand('visualCodeFlow.openRouteDeclaration');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), routesUri.toString());
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 2);

  await select('closure');
  state = await inspect();
  assert.match(state.status, /Route closure -> handler/);
  assert.ok(state.graph.nodes.some((node) => node.kind === 'return'));
  const previousGraph = JSON.stringify(state.graph);
  for (const name of ['missing', 'duplicate']) {
    await select(name);
    state = await inspect();
    assert.match(state.status, /handler is dynamic, unavailable, non-public or ambiguous/);
    assert.equal(JSON.stringify(state.graph), previousGraph, 'No arbitrary replacement handler');
  }

  // Editing route declarations invalidates declaration navigation as well as the active PHP graph.
  const edit = new vscode.WorkspaceEdit();
  edit.insert(routesUri, new vscode.Position(0, 0), '// moved\n');
  await vscode.workspace.applyEdit(edit);
  assert.equal((await inspect()).routeOrigin, undefined);
  await vscode.commands.executeCommand('visualCodeFlow.openRouteDeclaration');
  assert.match((await inspect()).status, /up-to-date Laravel route/);
  const restore = new vscode.WorkspaceEdit();
  restore.replace(
    routesUri,
    new vscode.Range(
      routeDocument.positionAt(0),
      routeDocument.positionAt(routeDocument.getText().length)
    ),
    routeText
  );
  await vscode.workspace.applyEdit(restore);
  await retry(async () => {
    await select('orders.index');
    assert.match((await inspect()).status, /Route orders.index -> handler/);
  });
}
module.exports = { runLaravel };
