import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';
import { buildControlFlowGraph, type FlowGraph } from '@visual-code-flow/flow-core';
import { createGraphWebview, isGraphViewMessage } from './webview.js';

export const OPEN_FLOW_COMMAND = 'visualCodeFlow.openFlow';

const adapter = new TypeScriptLanguageAdapter();

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let currentStatus = 'Select a function to view its flow.';
  let currentGraph: FlowGraph | undefined;

  const openFlow = vscode.commands.registerCommand(OPEN_FLOW_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }

    const document = editor.document;
    if (!adapter.supportedLanguages.includes(document.languageId)) {
      await vscode.window.showWarningMessage(
        'Visual Code Flow currently supports TypeScript and JavaScript files.'
      );
      return;
    }

    const selected = adapter.findFunction(
      {
        uri: document.uri.toString(),
        text: document.getText(),
        documentVersion: document.version,
        languageId: document.languageId
      },
      {
        line: editor.selection.active.line,
        character: editor.selection.active.character
      }
    );

    if (!selected) {
      await vscode.window.showInformationMessage('Place your cursor inside a function.');
      return;
    }

    currentStatus = `Selected function: ${selected.name} (line ${selected.location.start.line + 1})`;
    try {
      const analysis = await adapter.analyzeFunction(
        {
          uri: document.uri.toString(),
          text: document.getText(),
          documentVersion: document.version,
          languageId: document.languageId
        },
        selected
      );
      currentGraph = buildControlFlowGraph(analysis);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Visual Code Flow: ${details}`);
      return;
    }
    if (!panel) {
      panel = createGraphWebview(context);
      panel.onDidDispose(
        () => {
          panel = undefined;
        },
        null,
        context.subscriptions
      );
      panel.webview.onDidReceiveMessage(
        (message: unknown) => {
          if (!isGraphViewMessage(message)) return;
          if (message.type === 'ready') {
            void panel?.webview.postMessage({ type: 'status', message: currentStatus });
            if (currentGraph)
              void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
          }
        },
        null,
        context.subscriptions
      );
    } else {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    await panel.webview.postMessage({ type: 'status', message: currentStatus });
    await panel.webview.postMessage({ type: 'graph', graph: currentGraph });
  });

  context.subscriptions.push(openFlow, { dispose: () => panel?.dispose() });
}

export function deactivate(): void {
  // ExtensionContext owns registered listeners and panels.
}
