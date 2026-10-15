# ADR 0001: PHP analysis without executing the application

Status: accepted for the parser foundation; semantic coverage is tracked separately.

Epic: #55. First delivery: #56 (VCF-025).

## Context and decision

Use `php-parser` **3.7.0**, pinned exactly, as the JavaScript PHP AST frontend.
The package is BSD-3-Clause licensed and has no production dependencies. Its
source is bundled into the VSIX; PHP, Composer, Artisan, a language server and
network access are not runtime prerequisites. Preserve the upstream license
when packaging. Parsing a string is not executing PHP.

The Node test suite in `packages/analyzer-php/test/parser-probe.test.mjs`
checks the declarations and constructs needed by our initial fixtures, strict
syntax errors, and source offsets. Run it with `npm test -w
@visual-code-flow/analyzer-php` after installing workspace dependencies.
A green probe establishes AST availability, not control-flow correctness.

### Alternatives

- `nikic/PHP-Parser`: strong PHP-native frontend, but requires a PHP runtime or
  another bundled runtime, conflicting with the clean-install requirement.
- Tree-sitter PHP: attractive incremental parsing, but adds grammar/WASM/native
  distribution and error-node handling. Keep as an alternative if measured
  latency or grammar gaps justify migration.
- An editor definition provider alone: useful optional evidence, but does not
  provide our local CFG or guarantee availability in a clean profile.
- Regular-expression parsing: rejected for nested syntax, comments, strings,
  source locations and control-flow semantics.

## Boundaries

`analyzer-php` owns parsing, source positions and PHP symbol extraction. The
extension supplies snapshots and workspace file access. Laravel conventions
belong in a separate module and must not be imported by `flow-core`.

The host must select adapters by the source AND destination language. Shared
capabilities will include finding a definition and the exact call-name position.
Refresh, expansion and session restoration must not retain a hard-coded
TypeScript adapter. Optional providers may enrich evidence but must not silently
pick between multiple targets or turn an interface declaration into a body.

Flow IR changes must be generic. A switch is not a match; a finally block is not
an unconditional successor of every graph node. A closure declaration is not a
call to that closure. Unsupported constructs need explicit diagnostics rather
than plausible-looking invented edges. Incompatible IR or session shapes require
versioned validation and safe rejection of older snapshots.

## Positions, limits and privacy

Use parser offsets against the exact input JavaScript string and convert them to
zero-based UTF-16 editor positions, preserving CRLF and supplementary Unicode.
Never normalize newlines before parsing. Use the in-memory document snapshot,
not a stale disk copy. Strict parsing rejects incomplete edits; retain the last
valid graph with navigation/export disabled until locations are current again.

Limit file size, AST depth, workspace index size and cache entries. Cooperative
cancellation between bounded work units and generation checks must reject stale
results. Large synchronous parses must not block the Extension Host indefinitely;
measure the bounded path and use a worker when needed. Track cold parsing,
warm cache lookup and index rebuilding separately.

Do not execute application code, Composer scripts, autoload files, Artisan or
provider factories. Do not read `.env`, follow arbitrary external paths or upload
source. Exclude vendor/generated directories by default. Restrict diagnostics to
safe metadata; parser error strings can contain source fragments and must not
be copied into logs unfiltered.

## Compatibility contract

Priority: application syntax used with PHP 8.4 and Laravel 13. This does **not**
claim complete PHP 8.4 grammar support. Property hooks, asymmetric visibility and
other newer constructs require dedicated fixtures before any support claim.
Laravel metadata will be inferred statically and labelled as such, never shown
as a captured request execution or proven runtime service binding.

See [the coverage matrix](../php-support.md). Re-evaluate this decision when
fixtures demonstrate a material grammar gap, measured performance exceeds the
budget, or upstream maintenance/licensing changes.

## References

- [php-parser source and API](https://github.com/glayzzle/php-parser)
- [php-parser license](https://github.com/glayzzle/php-parser/blob/main/LICENSE)
- [Composer autoload schema](https://getcomposer.org/doc/04-schema.md#autoload)
- [Laravel routing](https://laravel.com/docs/13.x/routing)
