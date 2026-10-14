import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeScriptLanguageAdapter } from './adapter.js';

const adapter = new TypeScriptLanguageAdapter();

test('a function call assigned to a variable is still an expandable call node', async () => {
  const text = [
    'function helper(taxa: number) { return taxa / 100; }',
    'function calcJuros(valor: number, taxa: number) {',
    '  const percentual = helper(taxa);',
    '  return valor * (1 + percentual);',
    '}'
  ].join('\n');
  const request = {
    uri: 'file:///calc.ts',
    text,
    languageId: 'typescript',
    documentVersion: 1
  };
  const symbol = adapter.findFunction(request, { line: 2, character: 8 });
  assert.ok(symbol);
  const analysis = await adapter.analyzeFunction(request, symbol);
  assert.deepEqual(
    analysis.statements.map((item) => item.kind),
    ['call', 'return']
  );
  assert.equal(analysis.statements[0]?.location.start.line, 2);
});
