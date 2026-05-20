'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluateTransitions, MAX_HISTORY } = require('../scripts/lib/state-machine');

test('candidate → validated when evidence>=2 and no contradicting', () => {
  const card = {
    status: 'candidate',
    payload: { evidence_summary: ['a', 'b'] },
    contradicting: 0,
  };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'validated');
  assert.strictEqual(t.transitioned, true);
});

test('candidate → contradicted when contradicting>=1', () => {
  const card = {
    status: 'candidate',
    payload: { evidence_summary: ['a'] },
    contradicting: 1,
  };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'contradicted');
  assert.strictEqual(t.transitioned, true);
});

test('validated → deprecated when review_after past', () => {
  const past = new Date(Date.now() - 86400 * 1000).toISOString();
  const card = {
    status: 'validated',
    payload: { review_after: past, evidence_summary: ['a', 'b'] },
    contradicting: 0,
  };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'deprecated');
  assert.strictEqual(t.transitioned, true);
});

test('status_history caps at MAX_HISTORY (10)', () => {
  const history = Array(MAX_HISTORY + 5)
    .fill()
    .map((_, i) => ({
      from: 'a',
      to: 'b',
      at: '2026-01-01T00:00:00Z',
      by: `auto:${i}`,
    }));
  const card = { status: 'validated', payload: { status_history: history } };
  const out = evaluateTransitions(card, { trimHistory: true });
  assert.strictEqual(out.trimmed.length, MAX_HISTORY);
});
