import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';
import { PhpAnalysisError, PhpLanguageAdapter } from '@visual-code-flow/analyzer-php';
import {
  LanguageAdapterRegistry,
  type AnalysisRequest,
  type Cancellation
} from '@visual-code-flow/shared';
import { exportMermaid } from '@visual-code-flow/exporter-mermaid';
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
import { PhpWorkspace, documentSnapshot } from './php-workspace.js';
import { LaravelWorkspace } from './laravel-workspace.js';
import type { LaravelRoute } from '@visual-code-flow/analyzer-php';
import type { SourceSpan, TextPosition } from '@visual-code-flow/shared';

export const OPEN_FLOW_COMMAND = 'visualCodeFlow.openFlow';
export const OPEN_LARAVEL_ROUTE_COMMAND = 'visualCodeFlow.openLaravelRoute';

/** A single panel owns its revisions. No obsolete asynchronous result can replace its state. */
class FlowController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private status = 'Select a function to view its flow.';
  private graph: FlowGraph | undefined;
  private sourceMap: SourceMapIndex | undefined;
  private expansion: FlowExpansionSession | undefined;
  private sourceColumn = vscode.ViewColumn.One;
  private decoration: vscode.TextEditorDecorationType | undefined;
  private selectedId: string | undefined;
  private dirty = false;
  private revision = 0;
  private rootUri: string | undefined;
  private rootLanguage: string | undefined;
  private saveDestination: vscode.Uri | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly php = new PhpWorkspace();
  private readonly laravel = new LaravelWorkspace(this.php);
  private testRouteName: string | undefined;
  private routeOrigin: SourceSpan | undefined;
  private routeOriginRequest: AnalysisRequest | undefined;
  private readonly phpAdapter = new PhpLanguageAdapter({}, this.php);
  private readonly adapters = new LanguageAdapterRegistry([
    new TypeScriptLanguageAdapter(),
    this.phpAdapter
  ]);
  private readonly sessions: FlowSessionStore;
  private readonly refresh: LiveFlowRefresh;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sessions = new FlowSessionStore(context.workspaceState, async (uri, root) => {
      const rootDocument = vscode.workspace.textDocuments.find(
        (entry) => entry.uri.toString() === root
      );
      if (rootDocument?.languageId === 'php' && uri !== root) await this.php.assertReadable(uri);
    });
    this.refresh = new LiveFlowRefresh(
      this.adapters,
      (graph) => {
        this.revision++;
        this.expansion = new FlowExpansionSession(graph, readFlowSettings().maxExpansionDepth);
        this.dirty = false;
        this.selectedId = undefined;
        this.decoration?.dispose();
        this.decoration = undefined;
        this.updateGraph();
      },
      (message) => this.setStatus(message)
    );
    this.refresh.setDebounceMs(readFlowSettings().refreshDebounceMs);
    this.subscriptions.push(
      this.php,
      this.laravel,
      this.refresh,
      vscode.commands.registerCommand(OPEN_FLOW_COMMAND, () => this.openFlow()),
      vscode.commands.registerCommand(OPEN_LARAVEL_ROUTE_COMMAND, () => this.openLaravelRoute()),
      vscode.commands.registerCommand('visualCodeFlow.openRouteDeclaration', () =>
        this.openRouteDeclaration()
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.panel && this.refresh.onDocumentChanged(event, readFlowSettings().autoRefresh))
          this.markDirty();
      }),
      this.php.onDidChange((uri) => {
        this.routeOrigin = undefined;
        this.routeOriginRequest = undefined;
        if (
          this.panel &&
          this.rootUri &&
          this.rootLanguage === 'php' &&
          this.php.affects(this.rootUri, uri)
        ) {
          this.markDirty();
          this.refresh.invalidateDependencies(readFlowSettings().autoRefresh);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!this.panel || this.dirty || !this.sourceMap) return;
        const position = event.selections[0]?.active;
        if (!position) return;
        const node = this.sourceMap.findNode(event.textEditor.document.uri.toString(), position);
        if (node?.id === this.selectedId) return;
        this.selectedId = node?.id;
        this.post({ type: 'node:highlight', nodeId: this.selectedId });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('visualCodeFlow')) return;
        const settings = readFlowSettings();
        this.refresh.setDebounceMs(settings.refreshDebounceMs);
        this.post({ type: 'settings', layoutDirection: settings.layoutDirection });
        if (settings.autoRefresh && this.dirty) this.refresh.requestRefresh();
        if (this.expansion && this.expansion.maxDepth !== settings.maxExpansionDepth) {
          this.revision++;
          const previous = this.expansion.snapshot();
          this.expansion = new FlowExpansionSession(
            this.expansion.root,
            settings.maxExpansionDepth
          );
          this.expansion.restore(previous);
          this.updateGraph();
        }
      })
    );
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      this.subscriptions.push(
        vscode.commands.registerCommand('visualCodeFlow.__test.flushSession', () => this.persist()),
        vscode.commands.registerCommand('visualCodeFlow.__test.inspect', () => ({
          panel: !!this.panel,
          graph: this.graph,
          dirty: this.dirty,
          status: this.status,
          expandedIds: this.expansion?.expandedCalls ?? [],
          selectedId: this.selectedId,
          routeOrigin: this.routeOrigin
        })),
        vscode.commands.registerCommand('visualCodeFlow.__test.dispatch', (message: unknown) =>
          this.handle(message)
        ),
        vscode.commands.registerCommand('visualCodeFlow.__test.chooseRoute', (name: string) => {
          this.testRouteName = name;
        }),
        // Native dialog replacement exists only in an Extension Development Test Host.
        vscode.commands.registerCommand(
          'visualCodeFlow.__test.chooseSaveDestination',
          (uri: string) => {
            this.saveDestination = vscode.Uri.parse(uri);
          }
        )
      );
    }
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }
  private setStatus(message: string): void {
    this.status = message;
    this.post({ type: 'status', message });
  }
  private markDirty(): void {
    this.revision++;
    this.dirty = true;
    this.sessions.invalidate();
  }
  private token(revision: number): Cancellation {
    const isCancelled = (): boolean => this.revision !== revision;
    return {
      get isCancellationRequested() {
        return isCancelled();
      }
    };
  }
  private isSnapshotCurrent(request: AnalysisRequest): boolean {
    const document = vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === request.uri
    );
    return (
      !!document &&
      !document.isClosed &&
      document.version === request.documentVersion &&
      document.getText() === request.text
    );
  }
  private report(error: unknown, php = this.rootLanguage === 'php'): void {
    const message =
      error instanceof PhpAnalysisError
        ? error.message
        : php
          ? 'PHP operation unavailable; inspect project paths, exclusions and supported syntax.'
          : error instanceof Error
            ? error.message
            : 'Operation failed.';
    this.setStatus(`Visual Code Flow: ${message}`);
    if (!this.panel) void vscode.window.showWarningMessage(this.status);
  }
  private async contextKey(uri: string, language: string): Promise<string | undefined> {
    if (language !== 'php') return undefined;
    return this.php.contextKey(uri);
  }
  private async persist(allowClosed = false): Promise<void> {
    const session = this.expansion;
    const uri = this.rootUri;
    const language = this.rootLanguage;
    const revision = this.revision;
    if (this.dirty || !session || !uri || !language) return;
    try {
      const key = await this.contextKey(uri, language);
      if (
        this.dirty ||
        (this.revision !== revision &&
          !(allowClosed && this.revision === revision + 1 && !this.panel)) ||
        this.expansion !== session
      )
        return;
      await this.sessions.save(uri, session, this.selectedId, key);
    } catch {
      // Project metadata can be inaccessible; local analysis still remains usable.
    }
  }
  private publish(): void {
    this.post({ type: 'status', message: this.status });
    this.post({ type: 'settings', layoutDirection: readFlowSettings().layoutDirection });
    if (this.graph) this.post({ type: 'graph', graph: this.graph });
    this.post({ type: 'expanded', nodeIds: this.expansion?.expandedCalls ?? [] });
    this.post({ type: 'node:highlight', nodeId: this.selectedId });
  }
  private updateGraph(): void {
    if (!this.expansion) return;
    this.graph = this.expansion.getGraph();
    this.sourceMap = new SourceMapIndex(this.graph);
    this.refresh.watchGraph(this.graph);
    this.publish();
    void this.persist();
  }

  async openFlow(target?: {
    request: AnalysisRequest;
    position: TextPosition;
    cancellation?: Cancellation;
  }): Promise<void> {
    const editor = target
      ? await vscode.window.showTextDocument(vscode.Uri.parse(target.request.uri), {
          viewColumn: this.sourceColumn,
          preview: false
        })
      : vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }
    if (target?.cancellation?.isCancellationRequested) return;
    const document = editor.document;
    if (
      target &&
      (document.getText() !== target.request.text ||
        document.version !== target.request.documentVersion)
    ) {
      this.setStatus('The route handler changed; select the route again.');
      return;
    }
    if (target)
      editor.selection = new vscode.Selection(
        target.position.line,
        target.position.character,
        target.position.line,
        target.position.character
      );
    this.routeOrigin = undefined;
    this.routeOriginRequest = undefined;
    const adapter = this.adapters.get(document.languageId);
    if (!adapter || document.uri.path.toLowerCase().endsWith('.blade.php')) {
      this.setStatus(
        'Supported: TypeScript, JavaScript and PHP functions. Blade templates are not supported.'
      );
      void vscode.window.showInformationMessage(this.status);
      return;
    }
    const revision = ++this.revision;
    this.refresh.cancelPending();
    this.sessions.invalidate();
    const request = documentSnapshot(document);
    const token = this.token(revision);
    try {
      const selected = target
        ? (adapter.findFunctionDefinition?.(request, target.position) ??
          adapter.findFunction(request, target.position))
        : adapter.findFunction(request, editor.selection.active);
      if (!selected) {
        this.setStatus('Place your cursor inside a function or method with a body.');
        void vscode.window.showInformationMessage(this.status);
        return;
      }
      const analysis = await adapter.analyzeFunction(request, selected, token);
      if (token.isCancellationRequested || !this.isSnapshotCurrent(request)) return;
      const graph = buildControlFlowGraph(analysis);
      const session = new FlowExpansionSession(graph, readFlowSettings().maxExpansionDepth);
      let restored: Awaited<ReturnType<FlowSessionStore['restore']>> = undefined;
      try {
        const key = await this.contextKey(request.uri, request.languageId);
        restored = await this.sessions.restore(request.uri, graph, key);
      } catch {
        /* Do not restore sessions when project metadata is unavailable. */
      }
      if (token.isCancellationRequested || !this.isSnapshotCurrent(request)) return;
      if (restored) session.restore(restored.expansions);
      this.expansion = session;
      this.rootUri = request.uri;
      this.rootLanguage = request.languageId;
      this.sourceColumn = editor.viewColumn ?? vscode.ViewColumn.One;
      this.selectedId = restored?.selectedNodeId;
      this.dirty = false;
      this.decoration?.dispose();
      this.decoration = undefined;
      this.refresh.track(document, selected, graph);
      if (!this.panel) {
        const panel = createGraphWebview(this.context);
        this.panel = panel;
        this.subscriptions.push(
          panel.onDidDispose(() => {
            if (this.panel !== panel) return;
            void this.persist(true);
            this.panel = undefined;
            this.revision++;
            this.refresh.cancelPending();
          }),
          panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.handle(message).catch((error: unknown) => this.report(error));
          })
        );
      } else this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.setStatus(
        `Selected function: ${selected.name} (line ${selected.location.start.line + 1})`
      );
      this.updateGraph();
    } catch (error) {
      if (!token.isCancellationRequested) this.report(error, request.languageId === 'php');
    }
  }

  private async openLaravelRoute(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.setStatus('Open a file inside a Laravel Composer project first.');
      return;
    }
    const sourceUri = editor.document.uri.toString();
    const revision = ++this.revision;
    this.refresh.cancelPending();
    const token = this.token(revision);
    try {
      const snapshot = await this.laravel.scan(sourceUri, token);
      if (token.isCancellationRequested) return;
      if (!snapshot) {
        this.setStatus('No Laravel dependency found in the nearest Composer project.');
        return;
      }
      if (!snapshot.routes.length) {
        this.setStatus(`No statically recognized routes. ${snapshot.diagnostics.join(' ')}`);
        return;
      }
      const items = snapshot.routes.map((route) => ({
        label: `${route.methods.join('|') || '?'} ${route.path ?? '[dynamic URI]'}`,
        description: `${route.name ?? '(unnamed)'}${route.partial ? ' - partial declaration' : ''}`,
        detail: `Declared middleware: ${route.middleware.join(', ') || '(none here)'}. ${route.diagnostics.join(' ')}`,
        route
      }));
      let selected: { route: LaravelRoute } | undefined;
      if (
        this.context.extensionMode === vscode.ExtensionMode.Test &&
        this.testRouteName !== undefined
      ) {
        const name = this.testRouteName;
        this.testRouteName = undefined;
        selected = items.find((item) => item.route.name === name);
      } else
        selected = await vscode.window.showQuickPick(items, {
          title: 'Laravel route declarations - navigation, not an execution trace',
          placeHolder: snapshot.diagnostics.length
            ? `Partial index: ${snapshot.diagnostics.join(' ')}`
            : 'Select a route handler',
          matchOnDescription: true,
          matchOnDetail: true,
          ignoreFocusOut: true
        });
      if (!selected || token.isCancellationRequested) return;
      await this.laravel.assertCurrent(snapshot, sourceUri, token);
      const handler = await this.laravel.handler(snapshot, selected.route, token);
      if (token.isCancellationRequested) return;
      await this.laravel.assertCurrent(snapshot, sourceUri, token);
      if (token.isCancellationRequested) return;
      if (!handler) {
        this.routeOrigin = selected.route.source;
        this.routeOriginRequest = snapshot.documents.find(
          (document) => document.uri === selected.route.source.uri
        );
        this.setStatus(
          'Route handler is dynamic, unavailable, non-public or ambiguous. Use Open Route Declaration; no implementation was guessed.'
        );
        return;
      }
      const beforeOpen = this.revision;
      const routeStale = (): boolean =>
        token.isCancellationRequested || !this.laravel.isCurrent(snapshot);
      const openingToken: Cancellation = {
        get isCancellationRequested() {
          return routeStale();
        }
      };
      await this.openFlow({
        request: handler.request,
        position: handler.definition.start,
        cancellation: openingToken
      });
      if (this.revision !== beforeOpen + 1 || this.rootUri !== handler.request.uri || this.dirty)
        return;
      this.routeOrigin = selected.route.source;
      this.routeOriginRequest = snapshot.documents.find(
        (document) => document.uri === selected.route.source.uri
      );
      this.setStatus(
        `Route ${selected.route.name ?? selected.route.path ?? '(partial)'} -> handler. Navigation only; declared middleware is not the full runtime pipeline. ${selected.route.diagnostics.join(' ')}`
      );
    } catch (error) {
      if (!token.isCancellationRequested) this.report(error, true);
    }
  }

  private async openRouteDeclaration(): Promise<void> {
    const source = this.routeOrigin;
    const request = this.routeOriginRequest;
    if (!source || !request || this.dirty) {
      this.setStatus('Select an up-to-date Laravel route first.');
      return;
    }
    const token = this.token(this.revision);
    try {
      const current = await this.php.readPhp(source.uri);
      if (
        token.isCancellationRequested ||
        current.text !== request.text ||
        current.documentVersion !== request.documentVersion
      )
        return;
      await vscode.window.showTextDocument(vscode.Uri.parse(source.uri), {
        viewColumn: this.sourceColumn,
        preview: false,
        selection: new vscode.Range(
          source.start.line,
          source.start.character,
          source.end.line,
          source.end.character
        )
      });
    } catch (error) {
      if (!token.isCancellationRequested) this.report(error, true);
    }
  }

  private async handle(message: unknown): Promise<void> {
    if (!isGraphViewMessage(message)) return;
    if (message.type === 'ready') {
      this.publish();
      return;
    }
    if (!this.panel || !this.graph || this.dirty) {
      this.setStatus('Refresh the flow before navigation, expansion or export.');
      return;
    }
    const revision = this.revision;
    const token = this.token(revision);
    const session = this.expansion;
    if (message.type === 'diagram:copy' || message.type === 'diagram:save') {
      const diagram = exportMermaid(this.graph);
      if (message.type === 'diagram:copy') {
        await vscode.env.clipboard.writeText(diagram);
        return;
      }
      const destination =
        this.context.extensionMode === vscode.ExtensionMode.Test && this.saveDestination
          ? this.saveDestination
          : await vscode.window.showSaveDialog({
              filters: { Mermaid: ['mmd'] },
              saveLabel: 'Save Mermaid Diagram'
            });
      this.saveDestination = undefined;
      if (!destination || token.isCancellationRequested || this.dirty) return;
      await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(diagram));
      return;
    }
    if (!session) return;
    if (message.type === 'node:collapse') {
      if (session.collapse(message.nodeId!)) {
        this.revision++;
        this.updateGraph();
      }
      return;
    }
    if (message.type === 'node:expand') {
      const node = this.graph.nodes.find((item) => item.id === message.nodeId);
      if (!node?.source || node.kind !== 'call') return;
      try {
        const resolved = await resolveCalledFunction(
          this.adapters,
          node.source,
          token,
          this.php,
          (reason) => {
            if (!token.isCancellationRequested)
              this.setStatus(`Call not expanded: ${reason}. No runtime target was guessed.`);
          }
        );
        if (!resolved || token.isCancellationRequested || this.dirty || this.expansion !== session)
          return;
        const analysis = await resolved.adapter.analyzeFunction(
          resolved.request,
          resolved.symbol,
          token
        );
        if (
          token.isCancellationRequested ||
          !this.isSnapshotCurrent(resolved.request) ||
          this.dirty ||
          this.expansion !== session
        )
          return;
        const evidence =
          resolved.evidence ??
          'Source declaration; expansion is navigation, not an execution trace.';
        const outcome = session.expand(
          node.id,
          buildControlFlowGraph({ ...analysis, diagnostics: [...analysis.diagnostics, evidence] })
        );
        if (!outcome.ok) {
          this.setStatus(`Cannot expand call: ${outcome.reason}.`);
          return;
        }
        this.setStatus(`Expanded ${resolved.symbol.name}. ${evidence}`);
        this.updateGraph();
      } catch (error) {
        if (!token.isCancellationRequested) this.report(error);
      }
      return;
    }
    if (message.type === 'node:selected') {
      const location = this.sourceMap?.getSource(message.nodeId!);
      if (!location) return;
      try {
        if (this.rootLanguage === 'php' && location.uri !== this.rootUri)
          await this.php.assertReadable(location.uri);
        if (token.isCancellationRequested) return;
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
        if (token.isCancellationRequested || this.dirty) return;
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: this.sourceColumn,
          preserveFocus: false,
          preview: false
        });
        if (token.isCancellationRequested || this.dirty) return;
        const range = new vscode.Range(
          location.start.line,
          location.start.character,
          location.end.line,
          location.end.character
        );
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.decoration?.dispose();
        this.decoration = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
          isWholeLine: false
        });
        editor.setDecorations(this.decoration, [range]);
        this.selectedId = message.nodeId;
        void this.persist();
      } catch (error) {
        if (!token.isCancellationRequested) this.report(error);
      }
    }
  }

  dispose(): void {
    this.revision++;
    this.sessions.invalidate();
    this.decoration?.dispose();
    this.panel?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.phpAdapter.documents.clear();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new FlowController(context));
}

export function deactivate(): void {
  // ExtensionContext disposes the controller and every owned resource.
}
