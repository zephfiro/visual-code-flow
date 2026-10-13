import type { FlowGraph } from './model.js';

export interface GraphCacheKey {
  readonly uri: string;
  readonly version: number;
  readonly symbolId: string;
}

interface CacheEntry {
  readonly key: GraphCacheKey;
  readonly value: FlowGraph;
}

function cacheId(key: GraphCacheKey): string {
  return JSON.stringify([key.uri, key.version, key.symbolId]);
}

/**
 * Bounded LRU cache for completed graph snapshots.
 * Only graphs matching a document's current version should be published by callers.
 */
export class GraphAnalysisCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(readonly capacity = 32) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Graph cache capacity must be a positive safe integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: GraphCacheKey): FlowGraph | undefined {
    const id = cacheId(key);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  set(key: GraphCacheKey, graph: FlowGraph): void {
    const id = cacheId(key);
    this.entries.delete(id);
    this.entries.set(id, { key, value: graph });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidateDocument(uri: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.key.uri === uri) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Prevents outdated async analyses from publishing a graph after another request starts. */
export class AnalysisGeneration {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
