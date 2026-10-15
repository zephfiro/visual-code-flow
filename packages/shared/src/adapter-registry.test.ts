import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanguageAdapterRegistry } from './adapter-registry.js';
import { resolveFunctionCall, type FunctionResolutionHost } from './resolve-function.js';
import type {
  AnalysisRequest,
  FunctionDescriptor,
  LanguageAdapter,
  SourceSpan
} from './language-adapter.js';

const location = (uri: string): SourceSpan => ({
  uri,
  start: { line: 0, character: 0 },
  end: { line: 0, character: 20 }
});
const source = location('file:///caller.ts');
const destination = location('file:///target.php');
const request = (uri: string, languageId: string): AnalysisRequest => ({
  uri,
  languageId,
  text: 'test snapshot',
  documentVersion: 1
});
const symbol = (uri: string, languageId: string): FunctionDescriptor => ({
  symbolId: `${uri}#0`,
  name: 'target',
  languageId,
  location: location(uri),
  body: location(uri)
});
function adapter(language: string): LanguageAdapter {
  return {
    supportedLanguages: [language],
    findFunction: (input) => symbol(input.uri, language),
    analyzeFunction: async (_input, selected) => ({
      function: selected,
      statements: [],
      diagnostics: []
    }),
    resolveCall: async (_input, callSite) => ({
      callSite,
      targets: [{ symbolId: `${destination.uri}#0`, definition: destination }]
    })
  };
}
function host(): FunctionResolutionHost {
  return { readDocument: async (uri) => request(uri, uri.endsWith('.php') ? 'php' : 'typescript') };
}

test('registry routes immutable language registrations and rejects duplicates', () => {
  const ts = adapter('typescript');
  const php = adapter('php');
  const registry = new LanguageAdapterRegistry([ts, php]);
  assert.equal(registry.get('php'), php);
  assert.equal(registry.get('typescript'), ts);
  assert.equal(registry.get('unknown'), undefined);
  assert.ok(Object.isFrozen(registry.supportedLanguages));
  assert.throws(() => new LanguageAdapterRegistry([ts, ts]), /duplicate/);
  assert.throws(() => new LanguageAdapterRegistry([adapter('')]), /Invalid/);
});

test('cross-language navigation analyzes the target with its own adapter', async () => {
  const php = adapter('php');
  const result = await resolveFunctionCall(
    new LanguageAdapterRegistry([adapter('typescript'), php]),
    source,
    host()
  );
  assert.equal(result?.adapter, php);
  assert.equal(result?.request.languageId, 'php');
  assert.equal(result?.symbol.location.uri, destination.uri);
});

test('unknown source or target languages are not guessed', async () => {
  assert.equal(
    await resolveFunctionCall(new LanguageAdapterRegistry([]), source, host()),
    undefined
  );
  assert.equal(
    await resolveFunctionCall(new LanguageAdapterRegistry([adapter('typescript')]), source, host()),
    undefined
  );
});

test('missing or failed optional provider falls back to adapter evidence', async () => {
  const ts = { ...adapter('typescript'), findCallTargetPosition: () => source.start };
  const registry = new LanguageAdapterRegistry([ts, adapter('php')]);
  for (const findDefinitions of [
    async () => [],
    async () => {
      throw new Error('offline');
    }
  ]) {
    assert.ok(await resolveFunctionCall(registry, source, { ...host(), findDefinitions }));
  }
});

test('distinct provider definitions are ambiguous; duplicate evidence is deduplicated', async () => {
  let fallbackCalls = 0;
  const ts = {
    ...adapter('typescript'),
    findCallTargetPosition: () => source.start,
    resolveCall: async (_input: AnalysisRequest, callSite: SourceSpan) => {
      fallbackCalls++;
      return { callSite, targets: [] };
    }
  };
  const registry = new LanguageAdapterRegistry([ts, adapter('php')]);
  const one = { uri: destination.uri, position: destination.start };
  const two = { uri: 'file:///other.php', position: destination.start };
  assert.equal(
    await resolveFunctionCall(registry, source, {
      ...host(),
      findDefinitions: async () => [one, two]
    }),
    undefined
  );
  assert.ok(
    await resolveFunctionCall(registry, source, {
      ...host(),
      findDefinitions: async () => [one, one]
    })
  );
  assert.equal(fallbackCalls, 0);
});

test('explicit unresolved reasons are not turned into a successful resolution', async () => {
  const ts = {
    ...adapter('typescript'),
    resolveCall: async (_input: AnalysisRequest, callSite: SourceSpan) => ({
      callSite,
      targets: [{ symbolId: 'x', definition: destination }],
      reason: 'ambiguous' as const
    })
  };
  assert.equal(
    await resolveFunctionCall(new LanguageAdapterRegistry([ts, adapter('php')]), source, host()),
    undefined
  );
});

test('cancellation prevents document reads and rejects results after an await', async () => {
  const cancellation = { isCancellationRequested: true };
  let reads = 0;
  const context = {
    readDocument: async (uri: string) => {
      reads++;
      cancellation.isCancellationRequested = true;
      return request(uri, 'typescript');
    }
  };
  const registry = new LanguageAdapterRegistry([adapter('typescript')]);
  assert.equal(await resolveFunctionCall(registry, source, context, cancellation), undefined);
  assert.equal(reads, 0);
  cancellation.isCancellationRequested = false;
  assert.equal(await resolveFunctionCall(registry, source, context, cancellation), undefined);
  assert.equal(reads, 1);
});

test('precise definition lookup never guesses an enclosing implementation for a stub', async () => {
  const ts = { ...adapter('typescript'), findCallTargetPosition: () => source.start };
  const php = { ...adapter('php'), findFunctionDefinition: () => undefined };
  const context = {
    ...host(),
    findDefinitions: async () => [{ uri: destination.uri, position: { line: 0, character: 10 } }]
  };
  assert.equal(
    await resolveFunctionCall(new LanguageAdapterRegistry([ts, php]), source, context),
    undefined
  );
});
