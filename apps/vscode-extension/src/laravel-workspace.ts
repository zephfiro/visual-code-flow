import * as vscode from 'vscode';
import {
  checkCancellation,
  indexLaravelRoutes,
  PhpAnalysisError,
  PhpDocumentCache,
  PhpProjectIndex,
  type LaravelRoute,
  type LaravelRouteSnapshot,
  type ComposerMap
} from '@visual-code-flow/analyzer-php';
import type { AnalysisRequest, Cancellation, SourceSpan } from '@visual-code-flow/shared';
import { type PhpWorkspace } from './php-workspace.js';

export interface LaravelWorkspaceSnapshot extends LaravelRouteSnapshot {
  readonly map: ComposerMap;
  readonly contextKey: string;
  readonly generation: number;
}

/** Framework metadata is interpreted as literals, never by starting Laravel/PHP. */
export class LaravelWorkspace implements vscode.Disposable {
  private generation = 0;
  private readonly subscription: vscode.Disposable;
  private readonly documents = new PhpDocumentCache();

  constructor(private readonly php: PhpWorkspace) {
    this.subscription = php.onDidChange(() => {
      this.generation++;
      this.documents.clear();
    });
  }

  private cancellation(outer?: Cancellation): Cancellation {
    const generation = this.generation;
    const stale = (): boolean => generation !== this.generation;
    return {
      get isCancellationRequested() {
        return stale() || outer?.isCancellationRequested === true;
      }
    };
  }

  async scan(uri: string, outer?: Cancellation): Promise<LaravelWorkspaceSnapshot | undefined> {
    const token = this.cancellation(outer);
    const map = await this.php.projectFor(uri, token);
    checkCancellation(token);
    if (!map?.laravel) return undefined;
    const contextKey = await this.php.contextKey(uri);
    checkCancellation(token);
    const conventional = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.parse(map.root), 'routes/**/*.php'),
      '**/{vendor,node_modules,storage,.git}/**',
      65
    );
    checkCancellation(token);
    const snapshot = await indexLaravelRoutes(
      map,
      this.php.fileHost,
      conventional.map((entry) => entry.toString()).sort(),
      token
    );
    checkCancellation(token);
    return { ...snapshot, map, contextKey, generation: this.generation };
  }

  isCurrent(snapshot: LaravelWorkspaceSnapshot): boolean {
    return snapshot.generation === this.generation;
  }

  async assertCurrent(
    snapshot: LaravelWorkspaceSnapshot,
    uri: string,
    outer?: Cancellation
  ): Promise<void> {
    const token = this.cancellation(outer);
    if (!this.isCurrent(snapshot) || (await this.php.contextKey(uri)) !== snapshot.contextKey)
      throw new PhpAnalysisError('cancelled');
    checkCancellation(token);
    for (const request of snapshot.documents) {
      const current = await this.php.readPhp(request.uri);
      checkCancellation(token);
      if (current.text !== request.text || current.documentVersion !== request.documentVersion)
        throw new PhpAnalysisError('cancelled');
    }
  }

  async handler(
    snapshot: LaravelWorkspaceSnapshot,
    route: LaravelRoute,
    outer?: Cancellation
  ): Promise<{ request: AnalysisRequest; definition: SourceSpan } | undefined> {
    const token = this.cancellation(outer);
    if (route.handler.kind === 'unresolved') return undefined;
    const origin = snapshot.documents.find((document) => document.uri === route.source.uri);
    if (!origin) return undefined;
    let definition: SourceSpan;
    let expectedSymbol: string | undefined;
    if (route.handler.kind === 'closure') definition = route.handler.definition;
    else {
      const document = this.documents.get(origin, token);
      const index = new PhpProjectIndex(snapshot.map, this.php.fileHost);
      const result = await index.resolveMethod(
        document,
        route.source,
        route.handler.className,
        route.handler.method,
        token
      );
      checkCancellation(token);
      if (result.targets.length !== 1) return undefined;
      definition = result.targets[0]!.definition;
      expectedSymbol = result.targets[0]!.symbolId;
    }
    const request = await this.php.readPhp(definition.uri);
    checkCancellation(token);
    if (
      expectedSymbol &&
      !this.documents
        .get(request, token)
        .functions.some((fn) => fn.descriptor.symbolId === expectedSymbol)
    )
      throw new PhpAnalysisError('cancelled');
    return { request, definition };
  }

  dispose(): void {
    this.generation++;
    this.subscription.dispose();
    this.documents.clear();
  }
}
