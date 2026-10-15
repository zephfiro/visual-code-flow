# PHP symbol resolution

This layer resolves source declarations for navigation. A declared parameter or property type is not proof of the concrete runtime receiver. Successful targets carry an `evidence` explanation. Graph expansion must retain that distinction.

## Supported source evidence

- Named functions, including namespace fallback and `use function` aliases.
- Class aliases and grouped imports scoped to the actual namespace block.
- Literal constructors, direct constructed receivers, `self` and `parent`.
- Declared parameter types and ordinary/promoted property types accessed through `$this`.
- Directly invoked closures and arrow functions.
- Ordinary inheritance and simple trait composition. Private/protected method access is checked. Conflicting trait implementations stay ambiguous; adaptations are explicitly unsupported.

Interface declarations, multiple receiver types, duplicate class definitions, conditional declarations, late static binding, variable methods/classes and magic dispatch do not produce guessed implementations. Parameter reassignment and earlier argument passing (possible by-reference mutation) invalidate the declared-type shortcut. Untyped local-variable dataflow, arbitrary return-type inference, contextual container bindings and trait adaptations are not implemented here.

## Composer and workspace boundaries

`parseComposerMap` reads JSON only. PSR-4 and `autoload-dev` mappings produce exact on-demand candidate paths; explicit `autoload.files` entries make application helpers discoverable. PSR-0 and classmap entries are reported but not indexed. Since those competing maps can change which declaration wins, project resolution fails closed when they are present. Malformed supported sections also mark the map incomplete. No Composer scripts, generated PHP autoloaders, bootstrap code, environment files or PHP runtime are executed.

`PhpProjectIndex` belongs to one Composer root. It reads candidate snapshots through an injected host, with open editor buffers taking precedence. The host must report symbolic links instead of silently following them. Every candidate path is checked component by component; traversal, encoded separators, different URI authorities and generated/private trees are rejected. This is a source-reading policy, not a guarantee against concurrent filesystem replacement by another process.

Defaults bound each resolution to 96 attempted documents, 4,000,000 source code units and 32 dependency rounds. The parser cache remains bounded separately. Invalid or truncated supported mappings, parse failures, unsafe paths and exceeded limits yield `unsupported`, not a false unique target. Missing unindexed classes yield `external`; known classes without a method yield `not-found`.

Each resolution reads current snapshots and incrementally loads only required class/trait/parent dependencies. Cached parsing requires matching URI, version **and text**. `invalidate` also advances a generation counter, preventing pending reads from publishing a stale resolution. The extension host is responsible for routing each caller to its closest Composer root and forwarding file/configuration changes.

## Integration status

The PHP adapter provides local resolution without a file host. A `PhpCallResolver` may be injected for project resolution. VS Code activation, safe host reads, change watchers, displaying target evidence and optional definition-provider enrichment are delivered in the extension integration issue, not by this module alone.

## Validation

`composer.test.ts` covers paths, metadata limits and remote/Unicode URIs. `resolution.test.ts` exercises real parser declarations, aliases, inheritance, visibility, dynamic cases, project isolation, source edits, symlinks, budgets and cancellation. Run the repository's normal `npm run check` and `npm run format:check`; integration and packaging remain subject to the existing CI gates.
