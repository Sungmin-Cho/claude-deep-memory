'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact, STEP_A_MAPPERS } = require('../scripts/harvest');

test('harvest of recurring-findings fixture produces failure-case card with claim never-empty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-harv-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    // Fixture has 2 findings — 1 valid, 1 with empty evidence (F1 must filter it).
    assert.strictEqual(cards.length, 1, 'F1 must filter the empty-evidence finding');
    const c = cards[0];
    assert.strictEqual(c.payload.memory_type, 'failure-case');
    assert.ok(c.payload.claim.length > 0, 'F1: claim never empty');
    assert.ok(c.payload.title.length > 0, 'F1: title never empty');
    assert.ok(c.payload.evidence_summary.length > 0, 'F1: evidence_summary not empty');
    assert.match(c.payload.dedupe_key, /^sha256:[a-f0-9]{64}$/);
    assert.match(c.payload.memory_id, /^mem_failure_case_[a-f0-9]{6}$/);
    assert.strictEqual(c.payload.privacy_level, 'local');
    assert.strictEqual(c.payload.status, 'candidate');
    assert.strictEqual(c.payload.feedback.accepted_count, 0);
    assert.deepStrictEqual(c.payload.tags, ['codex', 'skill', 'manifest']);
    // applicability built from category
    assert.strictEqual(c.payload.applicability[0].value, 'manifest');
    assert.strictEqual(c.payload.applicability[0].source_id, 'src_0');
    // envelope
    assert.strictEqual(c.envelope.producer, 'deep-memory');
    assert.strictEqual(c.envelope.artifact_kind, 'memory-card');
    assert.strictEqual(c.envelope.schema.name, 'memory-card');
    assert.strictEqual(c.envelope.provenance.source_artifacts[0].artifact_kind, 'recurring-findings');
    // persisted to disk
    const onDisk = path.join(tmp, 'cards', 'failure-case', 'proj_test', c.payload.memory_id + '.json');
    assert.ok(fs.existsSync(onDisk));
    const persisted = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
    assert.strictEqual(persisted.payload.memory_id, c.payload.memory_id);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Phase 2 — STEP_A_MAPPERS only registers review-recurring (Phase 3a expands)', () => {
  assert.deepStrictEqual(Object.keys(STEP_A_MAPPERS), ['review-recurring']);
});

test('harvest throws on unknown sourceKind', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-harv-'));
  try {
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
        sourceKind: 'unknown-kind',
        memoryRoot: tmp,
        projectId: 'proj_test',
        skipDistillStepB: true,
      }),
      /Unknown sourceKind/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
