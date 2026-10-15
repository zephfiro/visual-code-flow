# Laravel route declarations

`Visual Code Flow: Open Laravel Route` scans the nearest Composer project of the active editor. The project must declare `laravel/framework` in Composer. Select an HTTP/path/name entry to open its closure or a uniquely identified public controller method. `Open Route Declaration` returns to the source declaration while its snapshot is current. The handler graph uses the existing PHP flow engine; route registration and middleware metadata are not inserted as runtime execution edges.

## Implemented literal grammar

The fixtures target Laravel 13 conventions and PHP 8.4 parsing. This is a source declaration index, not the result of `route:list`.

- Direct imported `Illuminate\Support\Facades\Route` calls, aliases and fully qualified names; the conventional global `Route` alias is flagged as an assumption.
- `get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `query`, `any`, and literal `match` method lists. GET declarations include HEAD.
- Closures/arrows, `[Controller::class, 'method']`, invokable controllers, literal controller strings, controller groups and literal namespace groups. Interfaces, abstract classes, non-public methods and duplicate PSR-4 definitions do not select arbitrary bodies.
- Nested group prefixes, names, declared middleware/exclusions and domains. The UI does not claim the effective middleware pipeline, priority, bindings, authorization or execution order.
- `resource`/`apiResource`, literal `only`/`except`, `names` maps, `parameters` maps and middleware. Resource parameter inflection is deliberately not guessed: provide `parameters()` for exact parameterized paths. Nested resources, global inflection/verb customizations and unsupported modifiers are partial rather than silently approximated.
- `bootstrap/app.php` with `Application::configure()->withRouting(web: ..., api: ..., apiPrefix: ..., using: ..., then: ...)`. Web/API declarations propagate the configured prefix and declared middleware. A custom `using` callback does not imply loading the default web/api files.
- Providers listed as literal class constants in `bootstrap/providers.php`; direct standard service-provider subclasses may declare routes in `boot` or a literal `$this->routes` callback. Indirect provider inheritance, dynamic registration and positional `withRouting` arguments remain limitations.
- Included route files with literal paths, `__DIR__`, concatenation, and globally resolved `base_path`/`dirname` forms. A relative string assumes the Composer-root working directory and is marked partial. Namespaced helper fallback and arbitrary function/constant evaluation are not performed.

Unreferenced `routes/**/*.php` files appear only as **conventional candidates**, explicitly marked as not proven to be registered. Conditional/repeated registrations are partial. Handler bodies and unrelated named functions are not scanned as though their declaration executed them. Modifiers that may change the handler do not authorize opening the original handler as the final one.

## Safety and freshness

The scan is bounded to 64 source documents, two million source characters, 128 traversal entries and 1,000 routes. It uses the same exclusion, regular-file, symlink, workspace-boundary and open-buffer policies as PHP expansion. Invalid/unreadable sources and limits are visible in index diagnostics. No PHP, Artisan, Composer scripts, bootstrap, application network requests, databases or `.env` reads are executed.

Selection is validated against Composer context and source snapshots after asynchronous steps. PHP/configuration changes cancel pending scans and clear declaration navigation. Raw source snapshots stay in the extension host; they are not sent to the route picker or Webview.

## Validation

`packages/analyzer-php/src/laravel-routes.test.ts` covers literals, aliases, groups, resources, dynamic cases, source ranges, include policies, provider callbacks, cancellation and method ambiguity. `apps/vscode-extension/e2e/suite/laravel.cjs` exercises the production command with a test-only picker choice, route -> controller -> PSR-4 service, closure handlers, unavailable/ambiguous handlers, Mermaid export and declaration invalidation. The same suite runs against the installed VSIX in CI; it does not require Laravel or a PHP runtime.

The E07 deliverable does not resolve Laravel container bindings or add Eloquent/job metadata; these are tracked separately in E08/E09.

## References

- [Laravel 13 routing](https://laravel.com/docs/13.x/routing)
- [Laravel route method normalization](https://github.com/laravel/framework/blob/13.x/src/Illuminate/Routing/Route.php)
- [Resource registrations](https://github.com/laravel/framework/blob/13.x/src/Illuminate/Routing/ResourceRegistrar.php)
- [Application routing configuration](https://github.com/laravel/framework/blob/13.x/src/Illuminate/Foundation/Configuration/ApplicationBuilder.php)
