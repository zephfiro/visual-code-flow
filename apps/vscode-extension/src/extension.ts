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
import { LiveFlowRefresh } from './live-refresh.js';
import { readFlowSettings } from './settings.js';
import { FlowSessionStore } from './session-store.js';

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
  let sourceDirty = false;
  let testDispatch: ((message: unknown) => void) | undefined;
  let rootUri: string | undefined;
  const sessionStore = new FlowSessionStore(context.workspaceState);

  const refresh = new LiveFlowRefresh(
    adapter,
    (graph, symbol) => {
      expansionSession = new FlowExpansionSession(graph, readFlowSettings().maxExpansionDepth);
      currentGraph = expansionSession.getGraph();
      currentSourceMap = new SourceMapIndex(currentGraph);
      selectedGraphNodeId = undefined;
      sourceDirty = false;
      activeDecoration?.dispose();
      activeDecoration = undefined;
      refresh.watchGraph(currentGraph);
      void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
      void panel?.webview.postMessage({ type: 'expanded', nodeIds: [] });
      void panel?.webview.postMessage({ type: 'node:highlight' });
      currentStatus = `Flow updated: ${symbol.name}`;
      persist();
    },
    (message) => {
      currentStatus = message;
      void panel?.webview.postMessage({ type: 'status', message });
    }
  );

  const persist = (): void => {
    if (!sourceDirty && rootUri && expansionSession) {
      void sessionStore.save(rootUri, expansionSession, selectedGraphNodeId);
    }
  };

  refresh.setDebounceMs(readFlowSettings().refreshDebounceMs);

  const openFlow = vscode.commands.registerCommand(OPEN_FLOW_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }

    refresh.cancelPending();
    sessionStore.invalidate();
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
      const graph = buildControlFlowGraph(analysis);
      const nextSession = new FlowExpansionSession(graph, readFlowSettings().maxExpansionDepth);
      const previous = await sessionStore.restore(document.uri.toString(), graph);
      if (previous) nextSession.restore(previous.expansions);
      expansionSession = nextSession;
      currentGraph = expansionSession.getGraph();
      rootUri = document.uri.toString();
      refresh.track(document, selected, graph);
      refresh.watchGraph(currentGraph);
      sourceDirty = false;
      currentSourceMap = new SourceMapIndex(currentGraph);
      selectedGraphNodeId = previous?.selectedNodeId;
      persist();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Visual Code Flow: ${details}`);
      return;
    }
    if (!panel) {
      panel = createGraphWebview(context);
      panel.onDidDispose(
        () => {
          persist();
          panel = undefined;
          testDispatch = undefined;
          refresh.cancelPending();
        },
        null,
        context.subscriptions
      );
      const handler = (message: unknown): void => {
          if (!isGraphViewMessage(message)) return;
          if (message.type === 'node:expand') {
            if (sourceDirty) return;
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
                refresh.watchGraph(currentGraph);
                persist();
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
            if (sourceDirty) return;
            if (!expansionSession?.collapse(message.nodeId!)) return;
            currentGraph = expansionSession.getGraph();
            currentSourceMap = new SourceMapIndex(currentGraph);
            refresh.watchGraph(currentGraph);
            persist();
            void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
            void panel?.webview.postMessage({
              type: 'expanded',
              nodeIds: expansionSession.expandedCalls
            });
            return;
          }
          if (message.type === 'node:selected') {
            if (sourceDirty) return;
            selectedGraphNodeId = message.nodeId;
            persist();
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
            void panel?.webview.postMessage({
              type: 'settings',
              layoutDirection: readFlowSettings().layoutDirection
            });
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
      };
      testDispatch = handler;
      panel.webview.onDidReceiveMessage(handler, null, context.subscriptions);
    } else {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    await panel.webview.postMessage({ type: 'status', message: currentStatus });
    await panel.webview.postMessage({
      type: 'settings',
      layoutDirection: readFlowSettings().layoutDirection
    });
    await panel.webview.postMessage({ type: 'graph', graph: currentGraph });
    await panel.webview.postMessage({
      type: 'expanded',
      nodeIds: expansionSession?.expandedCalls ?? []
    });
    await panel.webview.postMessage({ type: 'node:highlight', nodeId: selectedGraphNodeId });
  });

  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!panel) return;
    if (refresh.onDocumentChanged(event, readFlowSettings().autoRefresh)) {
      sourceDirty = true;
      sessionStore.invalidate();
    }
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

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('visualCodeFlow')) return;
    const settings = readFlowSettings();
    refresh.setDebounceMs(settings.refreshDebounceMs);
    void panel?.webview.postMessage({
      type: 'settings',
      layoutDirection: settings.layoutDirection
    });
    if (settings.autoRefresh && sourceDirty) refresh.requestRefresh();
    if (expansionSession && expansionSession.maxDepth !== settings.maxExpansionDepth) {
      const saved = expansionSession.snapshot();
      expansionSession = new FlowExpansionSession(
        expansionSession.root,
        settings.maxExpansionDepth
      );
      expansionSession.restore(saved);
      currentGraph = expansionSession.getGraph();
      currentSourceMap = new SourceMapIndex(currentGraph);
      refresh.watchGraph(currentGraph);
      void panel?.webview.postMessage({ type: 'graph', graph: currentGraph });
      void panel?.webview.postMessage({
        type: 'expanded',
        nodeIds: expansionSession.expandedCalls
      });
      persist();
    }
  });

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('visualCodeFlow.__test.inspect', () => ({
        panel: Boolean(panel),
        graph: currentGraph,
        dirty: sourceDirty,
        status: currentStatus,
        expandedIds: expansionSession?.expandedCalls ?? []
      })),
      vscode.commands.registerCommand('visualCodeFlow.__test.dispatch', (message: unknown) => {
        testDispatch?.(message);
      })
    );
  }

  context.subscriptions.push(refresh, changeListener, selectionListener, configListener, openFlow, {
    dispose: () => {
      activeDecoration?.dispose();
      panel?.dispose();
    }
  });
}

export function deactivate(): void {
  // ExtensionContext owns registered listeners and panels.
}
