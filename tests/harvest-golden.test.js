'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact, STEP_A_MAPPERS, mapEvolveInsights, mapWorkReceipt } = require('../scripts/harvest');

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

test('Phase 3a wiring — STEP_A_MAPPERS contains review-recurring + evolve-insights + work-receipt (docs/wiki added in 3a.3/3a.4)', () => {
  const keys = Object.keys(STEP_A_MAPPERS).sort();
  for (const required of ['evolve-insights', 'review-recurring', 'work-receipt']) {
    assert.ok(keys.includes(required), `STEP_A_MAPPERS missing ${required}: ${keys.join(',')}`);
  }
});

test('Step A: mapEvolveInsights — strategy → claim, q_delta normalized to confidence', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-evolve-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-evolve-insights.json'),
      sourceKind: 'evolve-insights',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 2);
    // first insight: q_delta=0.18 → confidence=0.36
    const c1 = cards[0];
    assert.strictEqual(c1.payload.memory_type, 'experiment-outcome');
    assert.strictEqual(c1.payload.claim, 'start with manifest drift tests before behavior tests');
    assert.strictEqual(c1.payload.title, c1.payload.claim, 'claim mirrors title');
    assert.strictEqual(c1.payload.evidence_summary[0], 'caught Codex compatibility regressions early');
    assert.ok(Math.abs(c1.payload.confidence - 0.36) < 1e-6,
      `expected confidence ~0.36, got ${c1.payload.confidence}`);
    assert.deepStrictEqual(c1.payload.tags, ['evolve', 'experiment']);
    assert.strictEqual(c1.payload.applicability.length, 2);
    assert.strictEqual(c1.payload.applicability[0].value, 'language=typescript');
    assert.strictEqual(c1.payload.applicability[1].value, 'topology=plugin');
    // second insight: q_delta=0.92 → saturates to 1.0
    const c2 = cards[1];
    assert.strictEqual(c2.payload.confidence, 1, 'q_delta >= 0.5 saturates to 1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mapEvolveInsights returns empty array for missing payload.insights (no F1 violation)', () => {
  const result = mapEvolveInsights({}, { id: 'src_0' });
  assert.deepStrictEqual(result, []);
});

test('Step A: mapWorkReceipt — success slice → pattern, failure slice → failure-case', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-work-'));
  try {
    const success = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-session-receipt-success.json'),
      sourceKind: 'work-receipt',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    assert.strictEqual(success.length, 1);
    const s = success[0];
    assert.strictEqual(s.payload.memory_type, 'pattern');
    assert.strictEqual(s.payload.claim, 'Pattern: implement envelope wrap — all tests pass');
    assert.deepStrictEqual(s.payload.evidence_summary, ['SLICE-001']);
    assert.deepStrictEqual(s.payload.tags, ['deep-work', 'pattern']);

    const failure = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-session-receipt-failure.json'),
      sourceKind: 'work-receipt',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    // 2 slices in fixture, 1 failure + 1 skipped → only failure persists
    assert.strictEqual(failure.length, 1);
    const f = failure[0];
    assert.strictEqual(f.payload.memory_type, 'failure-case');
    assert.strictEqual(f.payload.claim, 'Failure: FTS5 upsert lock window — lock acquired but FTS5 commit timed out');
    assert.deepStrictEqual(f.payload.evidence_summary, ['SLICE-002']);
    assert.deepStrictEqual(f.payload.tags, ['deep-work', 'failure-case']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mapWorkReceipt ignores slices with outcome other than success/failure (e.g. skipped)', () => {
  const result = mapWorkReceipt(
    { payload: { slices: [{ id: 'X', title: 't', outcome: 'skipped' }] } },
    { id: 'src_0' }
  );
  assert.deepStrictEqual(result, []);
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
