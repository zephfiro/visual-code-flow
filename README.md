# Visual Code Flow

Interactive, local-first code flow explorer for Visual Studio Code.

## Vision

Explore function control flow and cross-file calls through an interactive graph synchronized with the native VS Code editor.

## MVP

- TypeScript/JavaScript AST analysis
- Accurate control flow graph with source mapping
- React Flow diagram inside a VS Code webview
- Bidirectional navigation and lazy function expansion
- Live updates and Mermaid export

See `docs/architecture.md` (planned in the foundation epic) and the GitHub issue backlog.

## Development principles

Code is the source of truth. No cloud code uploads. Favor determinism, safe rendering, typed messaging, tests, and incremental changes.
