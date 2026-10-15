import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisRequest } from '@visual-code-flow/shared';
import { PhpDocumentCache } from './document.js';
import { extractLaravelRoutes } from './laravel-routes.js';
import { indexLaravelRoutes } from './laravel-project.js';
import { PhpProjectIndex, type PhpFileHost } from './project.js';
import { parseComposerMap } from './composer.js';
import { laravelPath } from './laravel-syntax.js';
const root = 'file:///project/';
const parse = (text: string, path = 'routes/web.php') =>
  new PhpDocumentCache().get({
    uri: root + path,
    text: '<?php ' + text,
    languageId: 'php',
    documentVersion: 1
  });
const routes = (text: string) =>
  extractLaravelRoutes(parse('use Illuminate\\Support\\Facades\\Route; ' + text), root);
const map = parseComposerMap(
  root,
  JSON.stringify({
    require: { 'laravel/framework': '^13.0' },
    autoload: { 'psr-4': { 'App\\': 'app/' } }
  })
);
function host(files: Record<string, string>): PhpFileHost {
  return {
    async stat(uri) {
      return uri.endsWith('/')
        ? 'directory'
        : files[uri.slice(root.length)] === undefined
          ? 'missing'
          : 'file';
    },
    async read(uri): Promise<AnalysisRequest | undefined> {
      const text = files[uri.slice(root.length)];
      return text === undefined ? undefined : { uri, text, languageId: 'php', documentVersion: 1 };
    }
  };
}

test('route metadata and real closure locations, not an execution of the callback body', () => {
  const result = routes(
    "Route::get('/hello', function() { Route::post('/not-registered', fn() => 1); return 2; })->name('hello');"
  );
  assert.equal(result.routes.length, 1);
  const item = result.routes[0]!;
  assert.equal(item.path, '/hello');
  assert.equal(item.name, 'hello');
  assert.deepEqual(item.methods, ['GET', 'HEAD']);
  assert.equal(item.handler.kind, 'closure');
  assert.equal(item.partial, false);
});

test('namespace aliases, invokable handlers and named PHP arguments', () => {
  const document = parse(
    "namespace Example; use Illuminate\\Support\\Facades\\Route as R; use App\\Http\\OrderController as C; R::post(uri: '/orders', action: [C::class, 'store']); R::get('/single', C::class);"
  );
  const result = extractLaravelRoutes(document, root).routes;
  assert.deepEqual(result[0]!.handler, {
    kind: 'controller',
    className: 'App\\Http\\OrderController',
    method: 'store'
  });
  assert.deepEqual(result[1]!.handler, {
    kind: 'controller',
    className: 'App\\Http\\OrderController',
    method: '__invoke'
  });
});

test('nested static groups propagate declared metadata without inventing runtime middleware order', () => {
  const result = routes(
    "Route::prefix('v1')->name('api.')->middleware(['auth'])->group(function () { Route::group(['prefix' => 'orders', 'as' => 'orders.', 'middleware' => 'audit'], function () { Route::delete('/{id}', [\\App\\C::class, 'destroy'])->name('destroy')->withoutMiddleware('auth'); }); });"
  );
  const item = result.routes[0]!;
  assert.equal(item.path, '/v1/orders/{id}');
  assert.equal(item.name, 'api.orders.destroy');
  assert.deepEqual(item.middleware, ['auth', 'audit']);
  assert.deepEqual(item.withoutMiddleware, ['auth']);
});

test('controller groups and legacy literal namespace groups preserve the declared handler', () => {
  const result = routes(
    "Route::controller(\\App\\C::class)->group(function() { Route::get('/x', 'index'); }); Route::group(['namespace'=>'App'], function() { Route::get('/y', 'C@index'); });"
  );
  for (const item of result.routes)
    assert.deepEqual(item.handler, { kind: 'controller', className: 'App\\C', method: 'index' });
});

test('resource options select handlers; explicit parameters permit exact URI templates', () => {
  const result = routes(
    "Route::apiResource('orders', \\App\\C::class)->only(['show','update'])->parameters(['orders'=>'order'])->names(['show'=>'orders.view']);"
  );
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0]!.path, '/orders/{order}');
  assert.equal(result.routes[0]!.name, 'orders.view');
  assert.deepEqual(result.routes[1]!.methods, ['PUT', 'PATCH']);
  assert.ok(result.routes.every((item) => !item.partial));
  const partial = routes("Route::resource('people', \\App\\C::class)->only('show');").routes[0]!;
  assert.equal(partial.path, undefined);
  assert.ok(partial.partial);
});

test('conditions, unknown modifiers and dynamic arguments explicitly mark candidates partial', () => {
  const result = routes(
    "if ($enabled) { Route::get('/conditional', [\\App\\C::class, 'index']); } Route::prefix($prefix)->group(function() { Route::post($path, $callback); }); Route::get('/x', fn()=>1)->customMacro();"
  );
  assert.equal(result.routes.length, 3);
  assert.ok(result.routes.every((item) => item.partial));
  assert.equal(result.routes[1]!.path, undefined);
  assert.equal(result.routes[2]!.path, undefined);
});

test('unrelated classes, functions and declarations after return are not route registrations', () => {
  const document = parse(
    "class Route {} Route::get('/shadow', fn()=>1); function later() { \\Illuminate\\Support\\Facades\\Route::get('/hidden', fn()=>1); }"
  );
  assert.equal(extractLaravelRoutes(document, root).routes.length, 0);
  assert.equal(routes("return; Route::get('/unreachable', fn()=>1);").routes.length, 0);
});

test('match and any metadata covers supported HTTP verbs including QUERY', () => {
  const result = routes("Route::match(['get', 'post'], '/x', fn()=>1); Route::any('/y', fn()=>1);");
  assert.deepEqual(result.routes[0]!.methods, ['GET', 'POST', 'HEAD']);
  assert.ok(result.routes[1]!.methods.includes('QUERY'));
});

test('route origin spans use unmodified UTF-16 and CRLF source', () => {
  const document = parse(
    'use Illuminate\\Support\\Facades\\Route;\r\n// caf\u00e9 \u{1f600}\r\nRoute::get("/x", fn()=>1);'
  );
  const route = extractLaravelRoutes(document, root).routes[0]!;
  assert.equal(route.source.start.line, 2);
  assert.equal(route.source.start.character, 0);
});

test('withRouting resolves anchored paths, api prefixes and custom using/then callbacks', () => {
  const document = parse(
    "use Illuminate\\Foundation\\Application; use Illuminate\\Support\\Facades\\Route; return Application::configure(basePath: dirname(__DIR__))->withRouting(web: __DIR__.'/../routes/web.php', api: __DIR__.'/../routes/api.php', apiPrefix:'api/v2', then: function(){ Route::get('/extra', fn()=>1); });",
    'bootstrap/app.php'
  );
  const result = extractLaravelRoutes(document, root);
  assert.equal(result.includes[0]!.uri, root + 'routes/web.php');
  assert.equal(result.includes[1]!.context.prefix, '/api/v2');
  assert.deepEqual(result.includes[1]!.context.middleware, ['api']);
  assert.equal(result.routes[0]!.path, '/extra');
  const custom = parse(
    "use Illuminate\\Foundation\\Application; use Illuminate\\Support\\Facades\\Route; return Application::configure()->withRouting(web:'routes/unused.php', using:function(){Route::get('/custom', fn()=>1);});",
    'bootstrap/app.php'
  );
  assert.equal(extractLaravelRoutes(custom, root).includes.length, 0);
});

test('path expressions reject absolute concatenations, secrets and escape attempts', () => {
  for (const expression of [
    "'/etc/passwd.php'",
    "'/' . 'etc/passwd.php'",
    "__DIR__.'/../../outside.php'",
    "base_path('.env')",
    "base_path('vendor/routes.php')",
    '$path',
    "base_path('routes/a.blade.php')"
  ]) {
    const document = parse('return ' + expression + ';', 'bootstrap/app.php');
    const returned = document.nodes.find((node) => node.kind === 'return')!;
    assert.equal(laravelPath(document, returned.expr, root), undefined, expression);
  }
});

test('provider route callbacks are indexed only in recognized provider boot methods', () => {
  const document = parse(
    "namespace App\\Providers; use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider; use Illuminate\\Support\\Facades\\Route; class Routes extends RouteServiceProvider { function boot() { $this->routes(function(){ Route::middleware('web')->group(\\base_path('routes/web.php')); }); } function helper() { Route::get('/not-called', fn()=>1); } }",
    'app/Providers/Routes.php'
  );
  const result = extractLaravelRoutes(document, root);
  assert.equal(result.includes[0]!.uri, root + 'routes/web.php');
  assert.equal(result.routes.length, 0);
});

test('project route traversal is bounded, handles configured includes and conventional candidates', async () => {
  const files = {
    'bootstrap/app.php':
      "<?php use Illuminate\\Foundation\\Application; return Application::configure()->withRouting(web:__DIR__.'/../routes/web.php');",
    'routes/web.php':
      "<?php use Illuminate\\Support\\Facades\\Route; Route::prefix('v1')->group(base_path('routes/nested.php'));",
    'routes/nested.php':
      "<?php use Illuminate\\Support\\Facades\\Route; Route::get('/x', fn()=>1);",
    'routes/unused.php':
      "<?php use Illuminate\\Support\\Facades\\Route; Route::get('/candidate', fn()=>1);"
  };
  const result = await indexLaravelRoutes(map, host(files), [
    root + 'routes/web.php',
    root + 'routes/unused.php'
  ]);
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0]!.path, '/v1/x');
  assert.deepEqual(result.routes[0]!.middleware, ['web']);
  assert.equal(result.routes[1]!.partial, true);
  const plain = await indexLaravelRoutes(parseComposerMap(root, '{}'), host(files));
  assert.equal(plain.routes.length, 0);
  assert.match(plain.diagnostics[0]!, /does not declare/);
});

test('symlinks, unreadable/invalid route files and cancellation never execute or leak sources', async () => {
  let read = false;
  const result = await indexLaravelRoutes(map, {
    async stat() {
      return 'symlink';
    },
    async read() {
      read = true;
      return undefined;
    }
  });
  assert.equal(read, false);
  assert.ok(result.diagnostics.length);
  await assert.rejects(
    indexLaravelRoutes(map, host({}), [], { isCancellationRequested: true }),
    /cancelled/i
  );
  const invalid = await indexLaravelRoutes(
    map,
    host({ 'bootstrap/app.php': '<?php secret_token( {' })
  );
  assert.ok(invalid.diagnostics.length);
  assert.ok(!JSON.stringify(invalid.diagnostics).includes('secret_token'));
});

test('literal method references resolve concrete public PSR-4 bodies and reject ambiguous/abstract/private targets', async () => {
  const document = parse(
    'use Illuminate\\Support\\Facades\\Route; Route::get("/x", [\\App\\C::class,"index"]);'
  );
  const source = extractLaravelRoutes(document, root).routes[0]!.source;
  const files = {
    'app/C.php':
      '<?php namespace App; class C { public function index() {return 1;} private function secret() {} }'
  };
  const index = new PhpProjectIndex(map, host(files));
  const found = await index.resolveMethod(document, source, 'App\\C', 'index');
  assert.equal(found.targets.length, 1);
  assert.equal(found.targets[0]!.definition.uri, root + 'app/C.php');
  assert.equal(
    (await index.resolveMethod(document, source, 'App\\C', 'secret')).reason,
    'unsupported'
  );
  files['app/C.php'] = '<?php namespace App; abstract class C { public function index() {} }';
  index.invalidate();
  assert.equal(
    (await index.resolveMethod(document, source, 'App\\C', 'index')).reason,
    'unsupported'
  );
  files['app/C.php'] =
    '<?php namespace App; class C { public function index() {} } class C { public function index() {} }';
  index.invalidate();
  assert.equal(
    (await index.resolveMethod(document, source, 'App\\C', 'index')).reason,
    'ambiguous'
  );
});

test('nested namespaces compose for literal string handlers without prefixing callable arrays', () => {
  const result = routes(
    "Route::namespace('App')->group(function() { Route::namespace('Http')->group(function() { Route::get('/x', 'Controller@index'); Route::get('/array', [\\Other\\Controller::class, 'index']); }); });"
  );
  assert.deepEqual(result.routes[0]!.handler, {
    kind: 'controller',
    className: 'App\\Http\\Controller',
    method: 'index'
  });
  assert.deepEqual(result.routes[1]!.handler, {
    kind: 'controller',
    className: 'Other\\Controller',
    method: 'index'
  });
});

test('unknown route modifiers cannot resolve a superseded handler', () => {
  const result = routes("Route::get('/x', [\\App\\C::class, 'index'])->uses($other);");
  assert.equal(result.routes[0]!.handler.kind, 'unresolved');
});

test('literal provider lists discover routes without executing provider methods', async () => {
  const result = await indexLaravelRoutes(
    map,
    host({
      'bootstrap/providers.php': '<?php return [\\App\\Providers\\Routes::class];',
      'app/Providers/Routes.php':
        "<?php namespace App\\Providers; use Illuminate\\Support\\ServiceProvider; use Illuminate\\Support\\Facades\\Route; class Routes extends ServiceProvider { public function boot() { Route::get('/provider', fn()=>1); } }"
    })
  );
  assert.equal(result.routes[0]!.path, '/provider');
});

test('cyclic route includes with changing prefixes stop at a documented traversal limit', async () => {
  const result = await indexLaravelRoutes(
    map,
    host({
      'bootstrap/app.php':
        "<?php use Illuminate\\Foundation\\Application; return Application::configure()->withRouting(web:base_path('routes/web.php'));",
      'routes/web.php':
        "<?php use Illuminate\\Support\\Facades\\Route; Route::prefix('again')->group(base_path('routes/web.php')); Route::get('/candidate',fn()=>1);"
    })
  );
  assert.ok(result.routes.length <= 128);
  assert.ok(result.diagnostics.some((message) => /limit/.test(message)));
});

test('dynamic controller groups and name prefixes never recover a false concrete value', () => {
  const result = routes(
    "Route::controller($controller)->group(function(){Route::get('/x', 'index');}); Route::get('/y', fn()=>1)->name($prefix)->name('tail');"
  );
  assert.equal(result.routes[0]!.handler.kind, 'unresolved');
  assert.equal(result.routes[1]!.name, undefined);
  assert.ok(result.routes.every((route) => route.partial));
});

test('missing configured sources are reported and resource macros do not guess a final handler', async () => {
  const result = await indexLaravelRoutes(
    map,
    host({
      'bootstrap/app.php':
        "<?php use Illuminate\\Foundation\\Application; return Application::configure()->withRouting(web:base_path('routes/missing.php'));"
    })
  );
  assert.ok(result.diagnostics.some((message) => /source is missing/.test(message)));
  assert.equal(
    routes("Route::resource('orders', \\App\\C::class)->customMacro();").routes[0]!.handler.kind,
    'unresolved'
  );
});
