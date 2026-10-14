import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';
import {
  AnalysisGeneration,
  buildControlFlowGraph,
  GraphAnalysisCache,
  translateAnchorOffset,
  type FlowGraph
} from '@visual-code-flow/flow-core';
import type { AnalysisRequest, FunctionDescriptor } from '@visual-code-flow/shared';

interface TrackedRoot {
  readonly uri: string;
  readonly name: string;
  anchorOffset: number;
}

function requestFor(document: vscode.TextDocument): AnalysisRequest {
  return {
    uri: document.uri.toString(),
    text: document.getText(),
    documentVersion: document.version,
    languageId: document.languageId
  };
}

export class LiveFlowRefresh implements vscode.Disposable {
  private root: TrackedRoot | undefined;
  private readonly watchedUris = new Set<string>();
  private readonly cache = new GraphAnalysisCache(24);
  private readonly generation = new AnalysisGeneration();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private debounceMs = 400;

  constructor(
    private readonly adapter: TypeScriptLanguageAdapter,
    private readonly publish: (graph: FlowGraph, symbol: FunctionDescriptor) => void,
    private readonly status: (message: string) => void
  ) {}

  get isTracking(): boolean {
    return this.root !== undefined;
  }

  setDebounceMs(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 100 || milliseconds > 5000) {
      throw new RangeError('Refresh debounce must be between 100 and 5000 milliseconds');
    }
    this.debounceMs = milliseconds;
  }

  track(document: vscode.TextDocument, symbol: FunctionDescriptor, graph: FlowGraph): void {
    this.cancelPending();
    const start = new vscode.Position(symbol.body.start.line, symbol.body.start.character);
    this.root = {
      uri: document.uri.toString(),
      name: symbol.name,
      anchorOffset: Math.min(document.getText().length, document.offsetAt(start) + 1)
    };
    this.cache.set(
      { uri: this.root.uri, version: document.version, symbolId: symbol.symbolId },
      graph
    );
    this.watchGraph(graph);
  }

  watchGraph(graph: FlowGraph): void {
    this.watchedUris.clear();
    if (this.root) this.watchedUris.add(this.root.uri);
    for (const node of graph.nodes) {
      if (node.source) this.watchedUris.add(node.source.uri);
    }
  }

  onDocumentChanged(event: vscode.TextDocumentChangeEvent): boolean {
    const uri = event.document.uri.toString();
    if (!this.root || !this.watchedUris.has(uri)) return false;
    if (uri === this.root.uri) {
      this.root.anchorOffset = translateAnchorOffset(this.root.anchorOffset, event.contentChanges);
    }
    this.cache.invalidateDocument(uri);
    this.schedule();
    return true;
  }

  private schedule(): void {
    this.generation.invalidate();
    if (this.timer) clearTimeout(this.timer);
    this.status('Source changed — updating flow…');
    const generation = this.generation.begin();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(generation);
    }, this.debounceMs);
  }

  private async refresh(generation: number): Promise<void> {
    const root = this.root;
    if (!root || !this.generation.isCurrent(generation)) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(root.uri));
      const request = requestFor(document);
      const position = document.positionAt(Math.min(root.anchorOffset, document.getText().length));
      const symbol = this.adapter.findFunction(request, {
        line: position.line,
        character: position.character
      });
      if (!this.generation.isCurrent(generation)) return;
      if (!symbol || symbol.name !== root.name) {
        this.status('The original function could not be found; keeping the last valid flow.');
        return;
      }
      const key = { uri: request.uri, version: request.documentVersion, symbolId: symbol.symbolId };
      let graph = this.cache.get(key);
      if (!graph) {
        const analysis = await this.adapter.analyzeFunction(request, symbol, {
          get isCancellationRequested() {
            return false;
          }
        });
        graph = buildControlFlowGraph(analysis);
        if (!this.generation.isCurrent(generation)) return;
        this.cache.set(key, graph);
      }
      if (!this.generation.isCurrent(generation)) return;
      this.publish(graph, symbol);
      this.status(`Flow updated: ${symbol.name}`);
    } catch (error) {
      if (!this.generation.isCurrent(generation)) return;
      const details = error instanceof Error ? error.message : String(error);
      this.status(`Unable to refresh: ${details}. Keeping the last valid flow.`);
    }
  }

  cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation.invalidate();
  }

  dispose(): void {
    this.cancelPending();
    this.root = undefined;
    this.watchedUris.clear();
    this.cache.clear();
  }
}
