import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypeScriptLanguageAdapter } from './adapter.js';

const adapter = new TypeScriptLanguageAdapter();

test('detects the innermost arrow function', () => {
  const text = 'function outer() { const inner = (value: number) => value + 1; return inner(2); }';
  const position = text.indexOf('value + 1');
  const descriptor = adapter.findFunction(
    { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 },
    { line: 0, character: position }
  );
  assert.equal(descriptor?.name, 'inner');
});

test('extracts statements from a TypeScript function', async () => {
  const text = 'function calc(value: number) { if (value > 0) return value; return 0; }';
  const request = { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 };
  const descriptor = adapter.findFunction(request, { line: 0, character: text.indexOf('if') });
  assert.ok(descriptor);
  const analysis = await adapter.analyzeFunction(request, descriptor);
  assert.deepEqual(
    analysis.statements.map((statement) => statement.kind),
    ['branch', 'return']
  );
});

test('returns undefined when cursor is outside any function', () => {
  const request = {
    uri: 'file:///test.js',
    text: 'const price = 42;',
    languageId: 'javascript',
    documentVersion: 1
  };
  assert.equal(adapter.findFunction(request, { line: 0, character: 3 }), undefined);
});

test('resolves a unique top-level function call', async () => {
  const text = 'function helper(x: number) { return x * 2; } function main() { helper(3); }';
  const request = { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 };
  const start = text.indexOf('helper(3)');
  const result = await adapter.resolveCall(request, {
    uri: request.uri,
    start: { line: 0, character: start },
    end: { line: 0, character: start + 'helper(3)'.length }
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]?.definition.start.character, 0);
});

test('does not infer dynamic method calls or unknown names', async () => {
  const text = 'function main() { service.helper(); missing(); }';
  const request = { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 };
  for (const [needle, reason] of [
    ['service.helper()', 'dynamic'],
    ['missing()', 'not-found']
  ] as const) {
    const start = text.indexOf(needle);
    const result = await adapter.resolveCall(request, {
      uri: request.uri,
      start: { line: 0, character: start },
      end: { line: 0, character: start + needle.length }
    });
    assert.deepEqual(result.targets, []);
    assert.equal(result.reason, reason);
  }
});

test('finds arrow function definitions at the declared variable name', () => {
  const text = 'export const helper = (x: number) => x + 1;';
  const request = { uri: 'file:///helpers.ts', text, languageId: 'typescript', documentVersion: 1 };
  const descriptor = adapter.findFunctionDefinition(request, {
    line: 0,
    character: text.indexOf('helper')
  });
  assert.equal(descriptor?.name, 'helper');
  assert.ok(descriptor?.location.start.character !== undefined);
});

test('finds the method identifier for definition-provider lookup', () => {
  const text = 'function main() { service.helper(2); }';
  const request = { uri: 'file:///main.ts', text, languageId: 'typescript', documentVersion: 1 };
  const callStart = text.indexOf('service.helper');
  const position = adapter.findCallTargetPosition(request, {
    uri: request.uri,
    start: { line: 0, character: callStart },
    end: { line: 0, character: callStart + 'service.helper(2);'.length }
  });
  assert.deepEqual(position, { line: 0, character: text.indexOf('helper') });
});
