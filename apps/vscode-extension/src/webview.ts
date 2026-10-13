import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface GraphViewMessage {
  readonly type: 'ready' | 'node:selected';
  readonly nodeId?: string;
}

export function createGraphWebview(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'visualCodeFlow',
    'Visual Code Flow',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const nonce = randomBytes(16).toString('base64');
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js')
  );
  const csp = [
    "default-src 'none'",
    `img-src ${panel.webview.cspSource} data:`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Visual Code Flow</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  return panel;
}

export function isGraphViewMessage(data: unknown): data is GraphViewMessage {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Record<string, unknown>;
  if (candidate.type === 'ready') return candidate.nodeId === undefined;
  return candidate.type === 'node:selected' && typeof candidate.nodeId === 'string'
    && candidate.nodeId.length > 0 && candidate.nodeId.length <= 256;
}
