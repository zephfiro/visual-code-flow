# PHP and Laravel coverage

This matrix records tested layers independently. The parser foundation alone
**does not enable PHP in the extension**. The existing TypeScript/JavaScript
experience remains unchanged until the adapter and host integration ship.

| Feature                                                           | Parser probe             | Semantic analysis / UI       |
| ----------------------------------------------------------------- | ------------------------ | ---------------------------- |
| Functions, methods, closures, arrows                              | Automated fixture        | Pending                      |
| Namespaces, aliases, promoted parameters                          | Automated fixture        | Pending                      |
| Attributes, unions/intersections, readonly classes, enums, traits | Automated fixture        | Pending                      |
| Branches, loops, switch, match, try/catch/finally                 | Automated fixture        | Pending                      |
| Unicode, CRLF and source offsets                                  | Automated fixture        | Pending adapter mapping      |
| Invalid PHP                                                       | Strict rejection fixture | Pending stale-graph handling |
| PHP 8.4 property hooks and asymmetric visibility                  | Not claimed              | Not claimed                  |
| Composer PSR-4 calls                                              | Not applicable           | Pending                      |
| Laravel routes, services and conventions                          | Not applicable           | Pending                      |

Pin: `php-parser@3.7.0`. The parser version option is `8.4`, not a promise that
all syntax introduced in that PHP version is supported. See the
[architectural decision](adr/0001-php-analysis.md) for runtime requirements,
privacy boundaries and the separation between AST support and a correct CFG.
