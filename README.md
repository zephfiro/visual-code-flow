# Visual Code Flow

**Visual Code Flow** is a local-first VS Code extension that turns function control flow into an interactive visual graph connected to the source editor.

## Features

- TypeScript and JavaScript AST analysis (TS, TSX, JS, JSX).
- Branch, loop, call and return nodes with source-linked navigation.
- Interactive React Flow viewer with zoom, pan, minimap and keyboard node selection.
- Expand/retract local and cross-file call implementations.
- Bidirectional code ↔ graph navigation and live source refresh.
- Workspace session restoration and configurable layout/expansion depth.
- Copy Mermaid source or save the visualized graph to a `.mmd` file.

## Install the MVP VSIX

Download the `visual-code-flow-0.1.0.vsix` artifact from a successful GitHub Actions build, then install it via **Extensions → … → Install from VSIX**, or run:

```bash
code --install-extension visual-code-flow-0.1.0.vsix
```

Put the cursor inside a JavaScript/TypeScript function, then invoke **Visual Code Flow: Open Flow** in the Command Palette.

## Develop

Requires Node.js 22 or newer and VS Code.

```bash
npm install
npm run check
npm run benchmark
xvfb-run -a npm run test:e2e
npm run package:vsix
```

- [Architecture and packages](docs/architecture.md)
- [Packaging and release](docs/release.md)
- [GitHub issues](https://github.com/zephfiro/visual-code-flow/issues)

## Privacy and known limitations

All analysis runs locally. The extension does not send source code to an external service. Dynamic calls, runtime polymorphism and unsupported control-flow constructs are shown conservatively, never guessed. Expanding a call is a navigational view, not an execution trace.

See the [extension README](apps/vscode-extension/README.md) for settings and supported interactions.

MIT License.
