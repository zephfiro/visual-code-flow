import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeScriptLanguageAdapter } from './adapter.js';

const adapter = new TypeScriptLanguageAdapter();

test('extracts nested branches and loop bodies without flattening control flow', async () => {
  const text = [
    'function check(value: number) {',
    '  if (value < 0) { return 0; }',
    '  else { while (value > 1) { value--; break; } }',
    '  return value;',
    '}'
  ].join('\n');
  const request = { uri: 'file:///check.ts', text, languageId: 'typescript', documentVersion: 1 };
  const symbol = adapter.findFunction(request, { line: 1, character: 5 });
  assert.ok(symbol);
  const analysis = await adapter.analyzeFunction(request, symbol);
  assert.equal(analysis.statements[0]?.kind, 'branch');
  assert.equal(analysis.statements[0]?.children?.[0]?.kind, 'return');
  assert.equal(analysis.statements[0]?.alternate?.[0]?.kind, 'loop');
  assert.equal(analysis.statements[0]?.alternate?.[0]?.children?.[1]?.kind, 'break');
  assert.equal(analysis.statements[1]?.kind, 'return');
});

test('classifies arrow expression body as implicit return', async () => {
  const request = {
    uri: 'file:///arrow.ts',
    text: 'const double = (n: number) => n * 2;',
    languageId: 'typescript',
    documentVersion: 1
  };
  const symbol = adapter.findFunction(request, { line: 0, character: 32 });
  assert.ok(symbol);
  const analysis = await adapter.analyzeFunction(request, symbol);
  assert.equal(analysis.statements[0]?.kind, 'return');
});
