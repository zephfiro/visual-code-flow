# PHP and Laravel coverage

PHP parsing, function discovery and structured control-flow extraction are implemented.
**PHP is not yet enabled in the extension UI**: Composer resolution and host activation
are separate deliveries. The existing TypeScript/JavaScript experience is preserved.

| Feature                                               | Tested coverage                                                           | Remaining limits                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Functions, methods, closures, arrows, traits          | Discovery, exact definitions and independent bodies                       | No execution of callback declarations                                     |
| Namespaces and modern declarations                    | Parser/discovery fixtures                                                 | Call-name resolution is a separate delivery                               |
| If/elseif, boolean short circuit, ternary, coalescing | Structured branches and selected operand evaluation                       | No general value/type inference                                           |
| For/foreach/while/do, break/continue levels           | Initialization, updates, backedges and abrupt completion tests            | Iterator protocol internals remain abstract                               |
| Switch and match                                      | Separate loose/strict comparisons, fall-through and unmatched-match throw | Runtime value comparison is not executed                                  |
| Try/catch/finally                                     | Pending normal/return/throw/jump paths; override rules; nested finalizers | Catch types are conservative; only explicit global Throwable is catch-all |
| Calls, arguments and nullsafe chains                  | Left-to-right argument evaluation; skipped suffixes/sub-chains            | Dynamic callee identity is not inferred                                   |
| General binary expressions / compound values          | Explicit opaque nodes with navigation-only call references                | Unestablished operand order is never guessed                              |
| Unicode and unsaved documents                         | UTF-16, LF/CRLF/CR mapping and bounded snapshot cache                     | No newline normalization                                                  |
| Invalid PHP / analysis limits                         | Sanitized errors, cancellation, bounded AST and graph size                | Not a replacement for the PHP compiler/type checker                       |
| Generators, goto, dynamic code loading                | Visible unsupported/truncated flow                                        | Suspension, arbitrary targets and loaded code are not modeled             |
| PHP 8.4 property hooks/asymmetric visibility          | Not claimed                                                               | Requires dedicated parser and semantic fixtures                           |
| Composer PSR-4 and Laravel conventions                | Pending                                                                   | See epic #55                                                              |

Pin: `php-parser@3.7.0`. The parser option `8.4` is not a promise of complete PHP
8.4 grammar coverage. See [ADR 0001](adr/0001-php-analysis.md).

## Interpreting the graph

This is a static, intraprocedural control-flow view, not an observed request or an
execution trace. An exception edge labelled `may throw` represents a possible
exception, not a proven thrown type. Dynamic runtime mechanisms and implicit
framework lifecycle calls are not silently inserted into the CFG.

Flow IR v2 distinguishes **reference** edges (dotted, navigation only) from
execution edges. Call implementations and calls inside opaque expressions use
references; these links must not be interpreted as an execution order. Mermaid
preserves the distinction. Version-1 session snapshots are rejected safely.

A finalizer can appear more than once: each source-linked copy represents a
_different pending continuation_ (normal, return, throw or a numbered jump).
That prevents a return path from incorrectly resuming after the try statement.
A return/throw inside finally overrides the pending continuation. Explicit
`exit`/`die` terminates without executing finally. Graph complexity limits stop
path duplication from growing without bound.

Complex assignment addresses and compound value elements may remain opaque.
Their call references remain navigable without asserting a fictitious ordering.
A terminal unsupported construct visibly truncates that unmodeled path instead
of connecting it to the next statement. Closures, arrows and first-class callable
creation never imply execution of the callback body.

## References used for semantic fixtures

- [PHP argument evaluation](https://www.php.net/manual/en/functions.arguments.php)
- [PHP operator precedence versus evaluation order](https://www.php.net/manual/en/language.operators.precedence.php)
- [Nullsafe operator and sub-chain short circuiting](https://wiki.php.net/rfc/nullsafe_operator)
- [PHP match semantics](https://www.php.net/manual/en/control-structures.match.php)
- [PHP exceptions and finally](https://www.php.net/manual/en/language.exceptions.php)
