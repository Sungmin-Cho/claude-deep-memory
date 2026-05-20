const test = require('node:test');
const assert = require('node:assert');
const { bm25MinMax, sigmoid, stalePenalty, scoreCard } = require('../scripts/lib/score');

test('bm25MinMax single result returns 1.0', () => {
  const r = bm25MinMax([{ bm25: 12.3 }]);
  assert.strictEqual(r[0].task_sim_norm, 1.0);
});

test('bm25MinMax multi-result inverts (P13 — smaller raw bm25 = better match)', () => {
  const r = bm25MinMax([{ bm25: 1 }, { bm25: 5 }, { bm25: 9 }]);
  assert.strictEqual(r[0].task_sim_norm, 1.0);  // raw=1 (best) → norm=1.0
  assert.strictEqual(r[2].task_sim_norm, 0.0);  // raw=9 (worst) → norm=0.0
});

test('sigmoid clamps to [0,1]', () => {
  // IEEE 754: sigmoid(-100) underflows to 0, sigmoid(100) saturates to 1
  assert.ok(sigmoid(-100) >= 0 && sigmoid(-100) < 0.01);
  assert.ok(sigmoid(100) > 0.99 && sigmoid(100) <= 1);
});

test('stalePenalty clamps to [0,1]', () => {
  const future = new Date(Date.now() + 86400 * 1000).toISOString();
  assert.strictEqual(stalePenalty(future, 90), 0);
  const veryOld = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
  assert.strictEqual(stalePenalty(veryOld, 90), 1);
});

test('scoreCard with missing profile forces w_project_sim=0', () => {
  const s = scoreCard({ confidence: 0.8, evidence_count: 2, feedback: { accepted: 0, rejected: 0 }, review_after: null, task_sim_norm: 0.5 }, { project_profile: null });
  assert.ok(s.score >= 0 && s.score <= 1);
  assert.strictEqual(s.parts.project_sim_norm, 0);
});
