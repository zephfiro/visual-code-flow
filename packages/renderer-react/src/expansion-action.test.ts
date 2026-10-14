import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlowNode } from '@visual-code-flow/flow-core';
import { expansionAction } from './expansion-action.js';

const call: FlowNode = { id: 'call', kind: 'call', label: 'helper()', expandable: true };

test('expands and collapses calls based on current graph state', () => {
  assert.deepEqual(expansionAction(call, new Set()), {
    type: 'node:expand',
    nodeId: 'call'
  });
  assert.deepEqual(expansionAction(call, new Set(['call'])), {
    type: 'node:collapse',
    nodeId: 'call'
  });
});

test('never attempts expansion for an unsupported or non-call node', () => {
  assert.equal(expansionAction({ ...call, expandable: false }, new Set()), undefined);
  assert.equal(
    expansionAction({ ...call, kind: 'operation', expandable: false }, new Set()),
    undefined
  );
});
