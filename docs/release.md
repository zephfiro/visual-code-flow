# Packaging and release checklist

The repository is an npm workspaces monorepo. Use Node.js 22+.

```bash
npm install
npm run check
xvfb-run -a npm run test:e2e
npm run benchmark
npm run package:vsix
```

The package is written to `apps/vscode-extension/artifacts/visual-code-flow-0.1.0.vsix`.

The extension host is bundled with esbuild as CommonJS (`dist/extension.cjs`), keeping the VS Code API external. The React Webview is built separately as `media/webview.js` and `media/webview.css`. Packaging uses `@vscode/vsce --no-dependencies` to avoid copying the monorepo's workspace symlinks.

The GitHub Actions release artifact job verifies archive integrity and the presence of the extension manifest, host bundle and Webview assets. It then uploads the VSIX as an Actions artifact; Marketplace publishing is not automatic.

For manual testing, install the VSIX in a clean VS Code profile and open a TypeScript file. Verify Command Palette activation, source navigation, expanding/collapsing a local call, cross-file definition, automatic refresh and reopening the Webview.

## Compatibility and safety

- MVP VS Code engine: `^1.96.0`.
- Supported languages: TypeScript/JavaScript (including TSX/JSX AST syntax).
- No external code uploads or remote scripts.
- Webview CSP restricts script loading and messages are validated.
