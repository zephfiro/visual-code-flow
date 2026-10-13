import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisGeneration, GraphAnalysisCache } from './cache.js';
import { FLOW_SCHEMA_VERSION, type FlowGraph } from './model.js';

function graph(rootSymbolId: string): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    rootSymbolId,
    nodes: [],
    edges: [],
    diagnostics: []
  };
}

test('uses version and symbol as part of the cache key', () => {
  const cache = new GraphAnalysisCache();
  const key = { uri: 'file:///a.ts', version: 1, symbolId: 'a' };
  cache.set(key, graph('a'));
  assert.equal(cache.get(key)?.rootSymbolId, 'a');
  assert.equal(cache.get({ ...key, version: 2 }), undefined);
  assert.equal(cache.get({ ...key, symbolId: 'b' }), undefined);
});

test('evicts least recently used entry when full', () => {
  const cache = new GraphAnalysisCache(2);
  const a = { uri: 'a', version: 1, symbolId: 'a' };
  const b = { uri: 'b', version: 1, symbolId: 'b' };
  const c = { uri: 'c', version: 1, symbolId: 'c' };
  cache.set(a, graph('a'));
  cache.set(b, graph('b'));
  cache.get(a);
  cache.set(c, graph('c'));
  assert.equal(cache.get(b), undefined);
  assert.equal(cache.get(a)?.rootSymbolId, 'a');
  assert.equal(cache.size, 2);
});

test('invalidates only matching document and supports clear', () => {
  const cache = new GraphAnalysisCache();
  cache.set({ uri: 'one', version: 1, symbolId: 's' }, graph('one'));
  cache.set({ uri: 'two', version: 1, symbolId: 's' }, graph('two'));
  cache.invalidateDocument('one');
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('rejects invalid cache capacities', () => {
  assert.throws(() => new GraphAnalysisCache(0), RangeError);
  assert.throws(() => new GraphAnalysisCache(1.5), RangeError);
});

test('invalidates stale asynchronous analysis generations', () => {
  const generation = new AnalysisGeneration();
  const first = generation.begin();
  const second = generation.begin();
  assert.equal(generation.isCurrent(first), false);
  assert.equal(generation.isCurrent(second), true);
  generation.invalidate();
  assert.equal(generation.isCurrent(second), false);
});
