import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisRequest, LanguageAdapter } from './language-adapter.js';

const request: AnalysisRequest = {
  uri: 'file:///example.ts',
  text: 'function calc() {}',
  languageId: 'typescript',
  documentVersion: 1
};

test('adapters can be implemented without importing the VS Code API', async () => {
  const adapter: LanguageAdapter = {
    supportedLanguages: ['typescript'],
    findFunction: () => undefined,
    analyzeFunction: async () => {
      throw new Error('Function was not found');
    },
    resolveCall: async (_request, callSite) => ({
      callSite,
      targets: [],
      reason: 'not-found'
    })
  };
  assert.equal(adapter.findFunction(request, { line: 0, character: 2 }), undefined);
  const span = {
    uri: request.uri,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 }
  };
  assert.deepEqual(await adapter.resolveCall(request, span), {
    callSite: span,
    targets: [],
    reason: 'not-found'
  });
});
