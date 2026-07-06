'use strict';
// Harvest envelope-contract guard: a sibling artifact whose M3 envelope header
// disagrees with the source kind's contract must be SKIPPED (not persisted)
// with a warning — instead of silently mapping schema-drifted / wrong-kind
// input into zero or garbage cards (SKILL.md Step 4 promise, previously
// unwired).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkEnvelopeContract, harvestArtifact } = require('../scripts/harvest');

const PROJECT_ID = 'proj_abcdef012345';

function envelope({ producer, artifact_kind, version }) {
  return {
    producer, producer_version: '9.9.9', artifact_kind,
    run_id: 'run_test', generated_at: '2026-05-19T00:00:00Z',
    schema: { name: artifact_kind, version },
    git: { head: '', branch: '', dirty: false },
    provenance: { source_artifacts: [] },
  };
}

// A minimal recurring-findings payload that yields ≥1 card when the guard passes.
function recurringPayload() {
  return {
    findings: [
      { category: 'bug', severity: 'high', pattern: 'null deref', evidence: 'foo.js:10', recommendation: 'guard it' },
      { category: 'bug', severity: 'high', pattern: 'null deref', evidence: 'bar.js:20', recommendation: 'guard it' },
    ],
  };
}

test('checkEnvelopeContract: matching envelope passes', () => {
  const raw = { envelope: envelope({ producer: 'deep-review', artifact_kind: 'recurring-findings', version: '1.0' }) };
  assert.deepStrictEqual(checkEnvelopeContract(raw, 'review-recurring'), { ok: true });
});

test('checkEnvelopeContract: backward-compatible MINOR bump (1.1) passes against supported 1.0', () => {
  const raw = { envelope: envelope({ producer: 'deep-docs', artifact_kind: 'last-scan', version: '1.1' }) };
  assert.deepStrictEqual(checkEnvelopeContract(raw, 'docs-scan'), { ok: true });
});

test('checkEnvelopeContract: breaking MAJOR bump (2.0) is rejected', () => {
  const raw = { envelope: envelope({ producer: 'deep-review', artifact_kind: 'recurring-findings', version: '2.0' }) };
  const r = checkEnvelopeContract(raw, 'review-recurring');
  assert.strictEqual(r.ok, false);
  assert.match(r.warning, /schema\.version '2\.0' major not in supported/);
});

test('checkEnvelopeContract: wrong producer is rejected', () => {
  const raw = { envelope: envelope({ producer: 'deep-evolve', artifact_kind: 'recurring-findings', version: '1.0' }) };
  const r = checkEnvelopeContract(raw, 'review-recurring');
  assert.strictEqual(r.ok, false);
  assert.match(r.warning, /producer 'deep-evolve' != expected 'deep-review'/);
});

test('checkEnvelopeContract: wrong artifact_kind is rejected', () => {
  const raw = { envelope: envelope({ producer: 'deep-review', artifact_kind: 'evolve-insights', version: '1.0' }) };
  const r = checkEnvelopeContract(raw, 'review-recurring');
  assert.strictEqual(r.ok, false);
  assert.match(r.warning, /artifact_kind 'evolve-insights' != expected 'recurring-findings'/);
});

test('checkEnvelopeContract: absent envelope is tolerated (legacy unwrapped artifact)', () => {
  assert.deepStrictEqual(checkEnvelopeContract({}, 'review-recurring'), { ok: true });
  assert.deepStrictEqual(checkEnvelopeContract({ envelope: {} }, 'review-recurring'), { ok: true });
});

test('harvestArtifact: mismatched envelope → skipped, NO cards/events persisted, warning attached', async () => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-guard-'));
  const artifactPath = path.join(memoryRoot, 'drifted.json');
  // Wrong-major schema (2.0) for review-recurring.
  fs.writeFileSync(artifactPath, JSON.stringify({
    envelope: envelope({ producer: 'deep-review', artifact_kind: 'recurring-findings', version: '2.0' }),
    payload: recurringPayload(),
  }));

  const cards = await harvestArtifact({
    artifactPath, sourceKind: 'review-recurring', memoryRoot, projectId: PROJECT_ID, skipDistillStepB: true,
  });

  assert.strictEqual(cards.length, 0, 'no cards from a skipped artifact');
  assert.strictEqual(cards.skipped, true, 'skipped marker set');
  assert.ok(Array.isArray(cards.warnings) && /envelope_mismatch/.test(cards.warnings[0]), 'warning attached');
  // Nothing persisted: no cards/ and no events/ under the memory root.
  assert.strictEqual(fs.existsSync(path.join(memoryRoot, 'cards')), false, 'no cards dir written');
  assert.strictEqual(fs.existsSync(path.join(memoryRoot, 'events')), false, 'no events dir written');
});

test('harvestArtifact: matching envelope → cards produced (guard is transparent to valid input)', async () => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-guard-ok-'));
  // Use the real local fixture (producer=deep-review, artifact_kind=recurring-findings,
  // schema 1.0) — known to yield cards in harvest-golden. Proves the guard does
  // not interfere with a contract-consistent artifact.
  const artifactPath = path.resolve(__dirname, 'fixtures', 'sample-recurring-findings.json');

  const cards = await harvestArtifact({
    artifactPath, sourceKind: 'review-recurring', memoryRoot, projectId: PROJECT_ID, skipDistillStepB: true,
  });

  assert.ok(cards.length >= 1, `expected >=1 card from valid artifact, got ${cards.length}`);
  assert.notStrictEqual(cards.skipped, true);
});
