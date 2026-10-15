import * as vscode from 'vscode';
import {
  PhpAnalysisError,
  PhpProjectIndex,
  checkCancellation,
  parseComposerMap,
  projectRootUri,
  relativeProjectPath,
  resolvePhpCall,
  type ComposerMap,
  type PhpCallResolver,
  type PhpDocument,
  type PhpFileHost
} from '@visual-code-flow/analyzer-php';
import type {
  AnalysisRequest,
  CallResolution,
  Cancellation,
  SourceSpan
} from '@visual-code-flow/shared';
import { documentHash } from './session-store.js';

export function documentSnapshot(document: vscode.TextDocument): AnalysisRequest {
  return {
    uri: document.uri.toString(),
    text: document.getText(),
    languageId: document.languageId,
    documentVersion: document.version
  };
}

/** Reads application sources as data, with no runtime, shell or language server dependency. */
export class PhpWorkspace implements PhpCallResolver, vscode.Disposable {
  private generation = 0;
  private readonly projects = new Map<string, { signature: string; index: PhpProjectIndex }>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changedEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChange = this.changedEmitter.event;
  readonly fileHost: PhpFileHost;

  constructor() {
    this.fileHost = {
      stat: async (uri) => {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
          if (stat.type & vscode.FileType.SymbolicLink) return 'symlink';
          if (stat.type & vscode.FileType.Directory) return 'directory';
          return stat.type & vscode.FileType.File ? 'file' : 'missing';
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound')
            return 'missing';
          throw new PhpAnalysisError('unsupported-document');
        }
      },
      read: async (uri) => this.readPhp(uri)
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/{*.php,composer.json,composer.lock}'
    );
    const invalidate = (uri: vscode.Uri): void => this.invalidate(uri);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(invalidate),
      watcher.onDidChange(invalidate),
      watcher.onDidDelete(invalidate),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          event.document.languageId === 'php' ||
          /\/composer\.(json|lock)$/.test(event.document.uri.path)
        ) {
          this.invalidate(event.document.uri);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('files.exclude') ||
          event.affectsConfiguration('visualCodeFlow.php')
        )
          this.invalidate();
      })
    );
  }

  invalidate(uri?: vscode.Uri): void {
    this.generation++;
    for (const value of this.projects.values()) value.index.invalidate(uri?.toString());
    if (!uri || /\/composer\.(json|lock)$/.test(uri.path)) this.projects.clear();
    this.changedEmitter.fire(uri);
  }

  affects(root: string, changed?: vscode.Uri): boolean {
    if (!changed) return true;
    const rootUri = vscode.Uri.parse(root);
    const folder = vscode.workspace.getWorkspaceFolder(rootUri);
    return (
      changed.toString() === root ||
      (!!folder && relativeProjectPath(folder.uri.toString(), changed.toString()) !== undefined)
    );
  }

  /** Validate automatic reads, including every symlink segment and VS Code exclusions. */
  async assertReadable(uri: string, maxBytes = 1_048_576): Promise<void> {
    const target = vscode.Uri.parse(uri);
    const folder = vscode.workspace.getWorkspaceFolder(target);
    const relative = folder && relativeProjectPath(folder.uri.toString(), uri);
    if (
      !folder ||
      relative === undefined ||
      [...relative].some((character) => '?*[]{}'.includes(character))
    )
      throw new PhpAnalysisError('unsupported-document');
    let current = projectRootUri(folder.uri.toString());
    const parts = relative.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const kind = await this.fileHost.stat(current);
      if (kind !== (i === parts.length ? 'file' : 'directory'))
        throw new PhpAnalysisError('unsupported-document');
      if (i < parts.length)
        current += encodeURIComponent(parts[i]!) + (i === parts.length - 1 ? '' : '/');
    }
    const matches = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, relative),
      undefined,
      1
    );
    if (!matches.some((entry) => entry.toString() === uri))
      throw new PhpAnalysisError('unsupported-document');
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.size > maxBytes || stat.type & vscode.FileType.SymbolicLink)
      throw new PhpAnalysisError('analysis-limit');
  }

  async readData(uri: string, maxBytes = 1_048_576): Promise<string> {
    await this.assertReadable(uri, maxBytes);
    const opened = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri
    );
    const text = opened
      ? opened.getText()
      : new TextDecoder('utf-8', { fatal: true }).decode(
          await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))
        );
    if (text.length > maxBytes) throw new PhpAnalysisError('analysis-limit');
    return text;
  }

  async readPhp(uri: string): Promise<AnalysisRequest> {
    if (!uri.toLowerCase().endsWith('.php') || uri.toLowerCase().endsWith('.blade.php'))
      throw new PhpAnalysisError('unsupported-document');
    await this.assertReadable(uri);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    if (document.languageId !== 'php' || document.getText().length > 256_000)
      throw new PhpAnalysisError('analysis-limit');
    return documentSnapshot(document);
  }

  /** The closest Composer root wins; never inspect parents outside a workspace. */
  async projectFor(uri: string, cancellation?: Cancellation): Promise<ComposerMap | undefined> {
    const source = vscode.Uri.parse(uri);
    const folder = vscode.workspace.getWorkspaceFolder(source);
    if (!folder || relativeProjectPath(folder.uri.toString(), uri) === undefined) return undefined;
    let directory = vscode.Uri.joinPath(source, '..');
    for (let depth = 0; depth < 32; depth++) {
      checkCancellation(cancellation);
      const candidate = vscode.Uri.joinPath(directory, 'composer.json');
      const kind = await this.fileHost.stat(candidate.toString());
      checkCancellation(cancellation);
      if (kind !== 'missing') {
        const text = await this.readData(candidate.toString(), 256_000);
        checkCancellation(cancellation);
        return parseComposerMap(directory.toString(), text);
      }
      if (projectRootUri(directory.toString()) === projectRootUri(folder.uri.toString()))
        return undefined;
      directory = vscode.Uri.joinPath(directory, '..');
    }
    throw new PhpAnalysisError('analysis-limit');
  }

  async contextKey(uri: string): Promise<string> {
    const map = await this.projectFor(uri);
    const exclusions = vscode.workspace
      .getConfiguration('files', vscode.Uri.parse(uri))
      .get('exclude');
    return documentHash(JSON.stringify({ policy: 'php-v1', map, exclusions }));
  }

  async resolve(
    document: PhpDocument,
    source: SourceSpan,
    cancellation?: Cancellation
  ): Promise<CallResolution> {
    const generation = this.generation;
    const isStale = (): boolean => generation !== this.generation;
    const token: Cancellation = {
      get isCancellationRequested() {
        return cancellation?.isCancellationRequested === true || isStale();
      }
    };
    const map = await this.projectFor(document.request.uri, token);
    checkCancellation(token);
    if (!map) return resolvePhpCall(document, source);
    const signature = JSON.stringify(map);
    let value = this.projects.get(map.root);
    if (!value || value.signature !== signature) {
      value?.index.invalidate();
      value = { signature, index: new PhpProjectIndex(map, this.fileHost) };
      this.projects.delete(map.root);
      if (this.projects.size >= 8) {
        const oldest = this.projects.keys().next().value!;
        this.projects.get(oldest)?.index.invalidate();
        this.projects.delete(oldest);
      }
      this.projects.set(map.root, value);
    }
    const result = await value.index.resolve(document, source, token);
    checkCancellation(token);
    return result;
  }

  dispose(): void {
    this.generation++;
    for (const value of this.projects.values()) value.index.invalidate();
    this.projects.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.changedEmitter.dispose();
  }
}
