import assert from 'node:assert/strict';
import test from 'node:test';
import { translateAnchorOffset } from './text-anchor.js';

test('preserves an anchor when edits occur after it', () => {
  assert.equal(translateAnchorOffset(10, [{ rangeOffset: 15, rangeLength: 2, text: '' }]), 10);
});

test('moves the anchor when code is inserted before a function', () => {
  assert.equal(translateAnchorOffset(10, [{ rangeOffset: 2, rangeLength: 0, text: 'hello' }]), 15);
});

test('places the anchor at the end of a replacing edit spanning it', () => {
  assert.equal(translateAnchorOffset(10, [{ rangeOffset: 8, rangeLength: 5, text: 'x' }]), 9);
});

test('handles multiple edits in descending source order', () => {
  const result = translateAnchorOffset(20, [
    { rangeOffset: 2, rangeLength: 0, text: 'abc' },
    { rangeOffset: 15, rangeLength: 3, text: 'x' }
  ]);
  assert.equal(result, 21);
});
