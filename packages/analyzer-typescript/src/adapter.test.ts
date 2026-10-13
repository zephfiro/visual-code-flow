import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypeScriptLanguageAdapter } from './adapter.js';

const adapter = new TypeScriptLanguageAdapter();

test('detects the innermost arrow function', () => {
  const text = 'function outer() { const inner = (value: number) => value + 1; return inner(2); }';
  const position = text.indexOf('value + 1');
  const descriptor = adapter.findFunction(
    { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 },
    { line: 0, character: position },
  );
  assert.equal(descriptor?.name, 'inner');
});

test('extracts statements from a TypeScript function', async () => {
  const text = 'function calc(value: number) { if (value > 0) return value; return 0; }';
  const request = { uri: 'file:///test.ts', text, languageId: 'typescript', documentVersion: 1 };
  const descriptor = adapter.findFunction(request, { line: 0, character: text.indexOf('if') });
  assert.ok(descriptor);
  const analysis = await adapter.analyzeFunction(request, descriptor);
  assert.deepEqual(analysis.statements.map((statement) => statement.kind), ['branch', 'return']);
});

test('returns undefined when cursor is outside any function', () => {
  const request = { uri: 'file:///test.js', text: 'const price = 42;', languageId: 'javascript', documentVersion: 1 };
  assert.equal(adapter.findFunction(request, { line: 0, character: 3 }), undefined);
});
