# PHP in VS Code

Open a PHP file, place the cursor inside a function/method/closure and run **Visual Code Flow: Open Flow**. The editor context menu includes PHP. Blade templates are deliberately excluded.

The VSIX bundles the parser. PHP, Composer, Artisan, Docker and third-party PHP extensions are not required. Local functions work in standalone files. Cross-file application declarations use the closest Composer root **inside an open VS Code workspace folder**. Open the project folder to enable PSR-4 resolution; the extension does not automatically explore parents of a standalone file.

## Navigation and evidence

PHP uses the same graph, expansion/collapse, editor synchronization, layout and Mermaid copy/save commands as TypeScript/JavaScript. Every expansion identifies static source evidence. A declared receiver type does not prove the runtime object's class.

Optional definition-provider enrichment is disabled by default. Enable `visualCodeFlow.php.useDefinitionProvider` to consult an installed provider for declarations the local resolver cannot find. Dynamic, ambiguous and explicitly unsupported targets cannot be overridden by a provider guess. Multiple definitions and declarations without bodies remain non-expandable. Provider requests have a two-second response budget.

## Workspace reads

Only source/metadata files are read; no application code, autoloader or Composer script is executed. Automatic reads validate each path component, reject symbolic links and unsafe/generated paths, respect VS Code `files.exclude`, and remain within the workspace. Automatic source paths containing glob metacharacters are conservatively unsupported. Open editor buffers take precedence over disk contents. PHP source and metadata sizes are limited; standalone selected buffers still use the parser's own limits.

Project contexts are isolated by Composer root. Source/Composer changes cancel outstanding resolutions, invalidate expanded graphs and prevent old results from replacing the current view. During invalid syntax or disabled refresh, stale navigation/expansion/export is blocked. Changing a PHP project mapping invalidates restored expansions even when the selected method text is unchanged.

Saved sessions validate source hashes and PHP context fingerprints before restoration. Unavailable metadata disables session restoration, not the basic function graph. Source ranges retain the editor's UTF-16/CRLF coordinates.

## Verification

The shared resolver has provider-policy tests. The Extension Host suite covers PHP controller-to-service PSR-4 expansion, Unicode/CRLF source navigation, copying and saving Mermaid, unchanged session restoration, invalid/unsaved buffers, Composer invalidation, language switching and Blade rejection. The packaging job runs the same functional suite against the **installed VSIX bundle in a clean profile**, not merely a source checkout.

Laravel route selection and framework-specific enrichment are subsequent deliveries. Recognizing `laravel/framework` in Composer does not yet imply route or container analysis.
