import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  FlowExpansionSession,
  FlowExpansionSnapshot,
  FlowGraph
} from '@visual-code-flow/flow-core';

const STORAGE_KEY = 'visualCodeFlow.workspaceSession';
const MAX_DOCUMENTS = 24;
const MAX_SNAPSHOT_BYTES = 750_000;

export interface StoredFlowSession {
  readonly schemaVersion: 2;
  readonly rootUri: string;
  readonly rootSymbolId: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly expansions: FlowExpansionSnapshot;
  readonly selectedNodeId?: string;
}

export function documentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class FlowSessionStore {
  private generation = 0;

  constructor(private readonly workspaceState: vscode.Memento) {}

  invalidate(): void {
    this.generation += 1;
  }

  async save(
    rootUri: string,
    session: FlowExpansionSession,
    selectedNodeId?: string
  ): Promise<void> {
    const generation = ++this.generation;
    const uris = new Set<string>([rootUri]);
    for (const node of session.getGraph().nodes) {
      if (node.source) uris.add(node.source.uri);
    }
    if (uris.size > MAX_DOCUMENTS) return;

    const sourceHashes: Record<string, string> = {};
    try {
      for (const uri of uris) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        sourceHashes[uri] = documentHash(document.getText());
      }
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    const saved: StoredFlowSession = {
      schemaVersion: 2,
      rootUri,
      rootSymbolId: session.root.rootSymbolId,
      sourceHashes,
      expansions: session.snapshot(),
      ...(selectedNodeId ? { selectedNodeId } : {})
    };
    if (JSON.stringify(saved).length > MAX_SNAPSHOT_BYTES) return;
    await this.workspaceState.update(STORAGE_KEY, saved);
  }

  async restore(rootUri: string, root: FlowGraph): Promise<StoredFlowSession | undefined> {
    const stored = this.workspaceState.get<StoredFlowSession>(STORAGE_KEY);
    if (
      !stored ||
      stored.schemaVersion !== 2 ||
      stored.rootUri !== rootUri ||
      stored.rootSymbolId !== root.rootSymbolId ||
      !stored.expansions ||
      !Array.isArray(stored.expansions.entries) ||
      !stored.sourceHashes ||
      typeof stored.sourceHashes !== 'object'
    ) {
      return undefined;
    }
    try {
      for (const [uri, hash] of Object.entries(stored.sourceHashes)) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        if (documentHash(document.getText()) !== hash) return undefined;
      }
    } catch {
      return undefined;
    }
    return stored;
  }
}
