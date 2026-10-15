# Visual Code Flow

Explore function control flow and cross-file calls without leaving VS Code.

## Getting started

1. Install the `.vsix` package: **Extensions** → **…** → **Install from VSIX**, or run `code --install-extension visual-code-flow-0.1.0.vsix`.
2. Open a PHP, TypeScript or JavaScript file (`.php`, `.ts`, `.tsx`, `.js`, or `.jsx`).
3. Place the cursor inside a function.
4. Run **Visual Code Flow: Open Flow** from the Command Palette or editor context menu.
5. Click graph nodes to navigate to their source. Double-click function-call nodes, or use the **Expand call** button, to explore their implementation. Use **Collapse** to return to the overview.

The diagram supports zoom, pan, a minimap, keyboard node selection, and source/editor highlighting. Use **Copy detailed Mermaid** or **Save detailed .mmd** to export the complete graph, including steps grouped in the simplified view. Function definitions across files are resolved using VS Code's active definition providers when available.

## Simplified PHP / Laravel flows

PHP and Laravel handlers open in **Simplified** view. A fluent query or response expression is displayed as one block instead of several intermediate reads and calls. Conditions, loops, explicit throws, catches, returns and separate `finally` paths remain visible.

Use **Detailed** to restore every node and path. Switching views does not reanalyze source or discard expanded calls. TypeScript/JavaScript retain Detailed as their default; the view choice is remembered separately for PHP and TS/JS while the panel is open.

Select a block and use **Show N steps** to navigate to an individual source step or expand its exact call. Double-clicking a grouped block expands its outermost available call. Potential uncaught-exception arrows to the function exit are hidden only in Simplified, with an explicit count; caught and explicit exception edges remain. Analysis notes are accessible in either view. Mermaid export deliberately remains complete rather than silently dropping exception paths.

## Settings

| Setting                            | Default | Description                                  |
| ---------------------------------- | ------- | -------------------------------------------- |
| `visualCodeFlow.autoRefresh`       | `true`  | Reanalyze on related document changes        |
| `visualCodeFlow.refreshDebounceMs` | `400`   | Refresh delay in milliseconds (100–5000)     |
| `visualCodeFlow.maxExpansionDepth` | `3`     | Maximum nested expansion depth (1–5)         |
| `visualCodeFlow.layoutDirection`   | `TB`    | Top-to-bottom (`TB`) or left-to-right (`LR`) |

Session expansions are stored in VS Code workspace state and only restored if the source contents still match. Code analysis happens locally and does not require an external service.

## Limitations

- Languages: PHP, TypeScript, TSX, JavaScript and JSX. PHP/Laravel coverage is conservative and documented per feature. Blade templates and JSX render-flow semantics are not analyzed.
- Static control flow is approximate for dynamic calls, runtime polymorphism and other constructs that cannot be determined reliably. Unresolved definitions are not guessed.
- Loops, branches and early exits are supported; some advanced syntax is marked unsupported rather than shown as a misleading execution path.
- Expanding a call shows a navigational subgraph rather than inlining its runtime stack behavior.
- This version does not edit source code by dragging nodes.

## Project

Source, issues and documentation: https://github.com/zephfiro/visual-code-flow

License: MIT.
