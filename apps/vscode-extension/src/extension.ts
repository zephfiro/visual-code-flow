import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';
import {
  buildControlFlowGraph,
  FlowExpansionSession,
  SourceMapIndex,
  type FlowGraph
} from '@visual-code-flow/flow-core';
import { createGraphWebview, isGraphViewMessage } from './webview.js';
import { resolveCalledFunction } from './call-resolver.js';

export const OPEN_FLOW_COMMAND = 'visualCodeFlow.openFlow';

const adapter = new TypeScriptLanguageAdapter();

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let currentStatus = 'Select a function to view its flow.';
  let currentGraph: FlowGraph | undefined;
  let currentSourceMap: SourceMapIndex | undefined;
  let expansionSession: FlowExpansionSession | undefined;
  let sourceEditorColumn: vscode.ViewColumn = vscode.ViewColumn.One;
  let activeDecoration: vscode.TextEditorDecorationType | undefined;
  let selectedGraphNodeId: string | undefined;

  const openFlow = vscode.commands.registerCommand(OPEN_FLOW_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }

    sourceEditorColumn = editor.viewColumn ?? vscode.ViewColumn.One;
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
      expansionSession = new FlowExpansionSession(buildControlFlowGraph(analysis));
      currentGraph = expansionSession.getGraph();
      currentSourceMap = new SourceMapIndex(currentGraph);
      selectedGraphNodeId = undefined;
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
          if (message.type === 'node:expand') {
            const session = expansionSession;
            const node = session?.getGraph().nodes.find((item) => item.id === message.nodeId);
            if (!session || !node?.source || node.kind !== 'call') return;
            void (async () => {
              try {
                const resolved = await resolveCalledFunction(adapter, node.source!);
                if (!resolved || expansionSession !== session) {
                  if (expansionSession === session) {
                    void vscode.window.showInformationMessage(
                      'Visual Code Flow: call definition could not be resolved.'
                    );
                  }
                  return;
                }
                const analysis = await adapter.analyzeFunction(resolved.request, resolved.symbol);
                if (expansionSession !== session) return;
                const outcome = session.expand(node.id, buildControlFlowGraph(analysis));
                if (!outcome.ok) {
                  void vscode.window.showInformationMessage(
                    `Visual Code Flow: cannot expand call (${outcome.reason}).`
                  );
                  return;
                }
                currentGraph = session.getGraph();
                currentSourceMap = new SourceMapIndex(currentGraph);
                await panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
                await panel?.webview.postMessage({
                  type: 'expanded',
                  nodeIds: session.expandedCalls
                });
              } catch (error) {
                const details = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(
                  `Visual Code Flow expansion failed: ${details}`
                );
              }
            })();
            return;
          }
          if (message.type === 'node:collapse') {
            if (!expansionSession?.collapse(message.nodeId!)) return;
            currentGraph = expansionSession.getGraph();
            currentSourceMap = new SourceMapIndex(currentGraph);
            void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
            void panel?.webview.postMessage({
              type: 'expanded',
              nodeIds: expansionSession.expandedCalls
            });
            return;
          }
          if (message.type === 'node:selected') {
            selectedGraphNodeId = message.nodeId;
            const location = currentSourceMap?.getSource(message.nodeId!);
            if (!location) return;
            void (async () => {
              try {
                const document = await vscode.workspace.openTextDocument(
                  vscode.Uri.parse(location.uri)
                );
                const editor = await vscode.window.showTextDocument(document, {
                  viewColumn: sourceEditorColumn,
                  preserveFocus: false,
                  preview: false
                });
                const range = new vscode.Range(
                  location.start.line,
                  location.start.character,
                  location.end.line,
                  location.end.character
                );
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                activeDecoration?.dispose();
                activeDecoration = vscode.window.createTextEditorDecorationType({
                  backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
                  isWholeLine: false
                });
                editor.setDecorations(activeDecoration, [range]);
              } catch (error) {
                const details = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(
                  `Visual Code Flow navigation failed: ${details}`
                );
              }
            })();
          }
          if (message.type === 'ready') {
            void panel?.webview.postMessage({ type: 'status', message: currentStatus });
            if (currentGraph)
              void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
            void panel?.webview.postMessage({
              type: 'expanded',
              nodeIds: expansionSession?.expandedCalls ?? []
            });
            void panel?.webview.postMessage({
              type: 'node:highlight',
              nodeId: selectedGraphNodeId
            });
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
    await panel.webview.postMessage({
      type: 'expanded',
      nodeIds: expansionSession?.expandedCalls ?? []
    });
  });

  const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!panel || !currentSourceMap) return;
    const node = currentSourceMap.findNode(event.textEditor.document.uri.toString(), {
      line: event.selections[0]?.active.line ?? 0,
      character: event.selections[0]?.active.character ?? 0
    });
    if (node?.id === selectedGraphNodeId) return;
    selectedGraphNodeId = node?.id;
    void panel.webview.postMessage({ type: 'node:highlight', nodeId: selectedGraphNodeId });
  });

  context.subscriptions.push(selectionListener, openFlow, {
    dispose: () => {
      activeDecoration?.dispose();
      panel?.dispose();
    }
  });
}

export function deactivate(): void {
  // ExtensionContext owns registered listeners and panels.
}
