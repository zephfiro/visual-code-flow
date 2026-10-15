import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanguageAdapterRegistry } from './adapter-registry.js';
import { resolveFunctionCall } from './resolve-function.js';
import type {
  AnalysisRequest,
  CallResolution,
  FunctionDescriptor,
  LanguageAdapter
} from './language-adapter.js';

const span = {
  uri: 'file:///a.php',
  start: { line: 0, character: 0 },
  end: { line: 1, character: 0 }
};
const request: AnalysisRequest = { uri: span.uri, languageId: 'php', text: '', documentVersion: 1 };
const symbol: FunctionDescriptor = {
  symbolId: 'target',
  name: 'target',
  location: span,
  body: span,
  languageId: 'php'
};
function registry(resolution: CallResolution) {
  const adapter: LanguageAdapter = {
    supportedLanguages: ['php'],
    findFunction: () => symbol,
    findFunctionDefinition: () => symbol,
    findCallTargetPosition: () => span.start,
    analyzeFunction: async () => ({ function: symbol, statements: [], diagnostics: [] }),
    resolveCall: async () => resolution
  };
  return new LanguageAdapterRegistry([adapter]);
}

test('adapter-first ambiguity/dynamic/unsupported vetoes provider guesses', async () => {
  for (const reason of ['ambiguous', 'dynamic', 'unsupported'] as const) {
    let providerCalls = 0;
    const result = await resolveFunctionCall(
      registry({ callSite: span, targets: [], reason }),
      span,
      {
        preferAdapter: true,
        readDocument: async () => request,
        findDefinitions: async () => {
          providerCalls++;
          return [{ uri: span.uri, position: span.start }];
        }
      }
    );
    assert.equal(result, undefined);
    assert.equal(providerCalls, 0);
  }
});

test('adapter evidence survives resolution without calling an optional provider', async () => {
  let providerCalls = 0;
  const result = await resolveFunctionCall(
    registry({
      callSite: span,
      targets: [{ symbolId: symbol.symbolId, definition: span, evidence: 'Declared type only.' }]
    }),
    span,
    {
      preferAdapter: true,
      readDocument: async () => request,
      findDefinitions: async () => {
        providerCalls++;
        return [];
      }
    }
  );
  assert.equal(result?.evidence, 'Declared type only.');
  assert.equal(providerCalls, 0);
});

test('an external declaration may use explicitly enabled provider enrichment', async () => {
  const result = await resolveFunctionCall(
    registry({ callSite: span, targets: [], reason: 'external' }),
    span,
    {
      preferAdapter: true,
      readDocument: async () => request,
      findDefinitions: async () => [{ uri: span.uri, position: span.start }]
    }
  );
  assert.equal(result?.symbol.symbolId, 'target');
  assert.match(result?.evidence ?? '', /runtime dispatch is not established/);
});

test('foreign document snapshots and malformed provider positions are rejected', async () => {
  const adapters = registry({ callSite: span, targets: [], reason: 'not-found' });
  assert.equal(
    await resolveFunctionCall(adapters, span, {
      readDocument: async () => ({ ...request, uri: 'file:///other' })
    }),
    undefined
  );
  assert.equal(
    await resolveFunctionCall(adapters, span, {
      readDocument: async () => request,
      findDefinitions: async () => [{ uri: span.uri, position: { line: -1, character: 0 } }]
    }),
    undefined
  );
});
