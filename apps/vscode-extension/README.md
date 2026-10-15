# Visual Code Flow

Explore function control flow and cross-file calls without leaving VS Code.

## Getting started

1. Install the `.vsix` package: **Extensions** → **…** → **Install from VSIX**, or run `code --install-extension visual-code-flow-0.1.0.vsix`.
2. Open a TypeScript or JavaScript file (`.ts`, `.tsx`, `.js`, or `.jsx`).
3. Place the cursor inside a function.
4. Run **Visual Code Flow: Open Flow** from the Command Palette or editor context menu.
5. Click graph nodes to navigate to their source. Double-click function-call nodes, or use the **Expand call** button, to explore their implementation. Use **Collapse** to return to the overview.

The diagram supports zoom, pan, a minimap, keyboard node selection, and source/editor highlighting. Use **Copy Mermaid** or **Save .mmd** in the toolbar to export the current graph. Function definitions across files are resolved using VS Code's active definition providers when available.

## Settings

| Setting                            | Default | Description                                  |
| ---------------------------------- | ------- | -------------------------------------------- |
| `visualCodeFlow.autoRefresh`       | `true`  | Reanalyze on related document changes        |
| `visualCodeFlow.refreshDebounceMs` | `400`   | Refresh delay in milliseconds (100–5000)     |
| `visualCodeFlow.maxExpansionDepth` | `3`     | Maximum nested expansion depth (1–5)         |
| `visualCodeFlow.layoutDirection`   | `TB`    | Top-to-bottom (`TB`) or left-to-right (`LR`) |

Session expansions are stored in VS Code workspace state and only restored if the source contents still match. Code analysis happens locally and does not require an external service.

## Limitations

- MVP languages: TypeScript, TSX, JavaScript and JSX. JSX render-flow semantics and PHP are not analyzed.
- Static control flow is approximate for dynamic calls, runtime polymorphism and other constructs that cannot be determined reliably. Unresolved definitions are not guessed.
- Loops, branches and early exits are supported; some advanced syntax is marked unsupported rather than shown as a misleading execution path.
- Expanding a call shows a navigational subgraph rather than inlining its runtime stack behavior.
- This version does not edit source code by dragging nodes.

## Project

Source, issues and documentation: https://github.com/zephfiro/visual-code-flow

License: MIT.
