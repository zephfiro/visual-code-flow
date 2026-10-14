# Visual Code Flow — Architecture

## Goals

Offer local-first, deterministic code control-flow visualization with navigation between source locations and a React Flow Webview.

## Packages

- `apps/vscode-extension`: VS Code extension host, commands, editor navigation, definition providers, session persistence and Webview messaging.
- `packages/shared`: language-neutral adapter interface (`AnalysisRequest`, `FunctionDescriptor`, `StatementDescriptor`, `CallResolution`).
- `packages/analyzer-typescript`: TypeScript Compiler API parsing and extraction of supported statements/calls.
- `packages/flow-core`: versioned Flow IR, structural validation, CFG assembly, source mapping, cache and expansion session.
- `packages/renderer-react`: React Flow + Dagre Webview, theme-aware controls and layout.
- `packages/exporter-mermaid`: Mermaid serialization from Flow IR.

The core does not depend on VS Code or React. Rendering does not consume raw code strings as executable HTML; Webview messaging is validated and subject to Content Security Policy.

## Flow pipeline

1. Cursor position → AST function descriptor.
2. Function body → language-neutral ordered statement descriptors.
3. Statement descriptors → validated CFG with edges for conditions, loops, returns, throws and exits.
4. CFG → source-position lookup index and styled React Flow nodes.
5. Clicking a node sends its ID to the extension host, which opens/reveals the source range.
6. Cursor movement finds the best matching node in the current source index.
7. On-demand call expansion uses VS Code definition providers, then a new CFG with ancestor/recursion/depth checks.
8. Document edits invalidate affected graphs, debounce rebuilds and prevent stale source navigation.

Expansion links are for navigation, not additional runtime-execution edges.

## Session and configuration

Settings are scoped to VS Code's `visualCodeFlow` configuration. The current workspace snapshot stores expanded graphs and hashes of their source documents. Snapshots are ignored when a root identifier, document hash or structure does not match.

No cloud service or AI is required. Source code is processed locally. Future adapters (e.g. PHP) may reuse the Flow IR without changing the renderer.

## Testing

- `npm run check`: ESLint, typecheck, unit tests and builds.
- `npm run test:e2e`: VS Code Extension Development Host E2E (Linux requires Xvfb).
- `npm run benchmark`: synthetic p95 for analysis of a 200-line function and source-index lookup.
- `npm run package:vsix`: build a self-contained VSIX in the extension's artifacts directory.

Benchmark targets are reference budgets, not proof of visual Webview latency.
