'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  harvestArtifact,
  STEP_A_MAPPERS,
  mapEvolveInsights,
  mapWorkReceipt,
  mapDocsScan,
  mapWikiIndex,
  passesF1,
  partitionByF1,
} = require('../scripts/harvest');

test('harvest of recurring-findings fixture produces failure-case card with claim never-empty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-harv-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // Fixture has 2 findings — 1 valid, 1 with empty description+example_files (F1 must filter it).
    assert.strictEqual(cards.length, 1, 'F1 must filter the empty-description finding');
    const c = cards[0];
    assert.strictEqual(c.payload.memory_type, 'failure-case');
    assert.ok(c.payload.claim.length > 0, 'F1: claim never empty');
    assert.ok(c.payload.title.length > 0, 'F1: title never empty');
    assert.ok(c.payload.evidence_summary.length > 0, 'F1: evidence_summary not empty');
    assert.match(c.payload.dedupe_key, /^sha256:[a-f0-9]{64}$/);
    assert.match(c.payload.memory_id, /^mem_failure_case_[a-f0-9]{16}$/);
    assert.strictEqual(c.payload.privacy_level, 'local');
    assert.strictEqual(c.payload.status, 'candidate');
    assert.strictEqual(c.payload.feedback.accepted_count, 0);
    // sibling-real shape: tags = [category, severity]
    assert.deepStrictEqual(c.payload.tags, ['manifest', 'critical']);
    // applicability built from category as 'category=<category>'
    assert.strictEqual(c.payload.applicability[0].value, 'category=manifest');
    assert.strictEqual(c.payload.applicability[0].source_id, 'src_0');
    // claim is the description (verbatim, F1 source)
    assert.match(c.payload.claim, /Codex skill discovery silently fails/);
    // title is description truncated to 80 chars
    assert.ok(c.payload.title.length <= 80);
    // evidence_summary comes from example_files (max 5)
    assert.deepStrictEqual(c.payload.evidence_summary, [
      'skills/wiki-ingest/SKILL.md',
      'skills/wiki-query/SKILL.md',
      'skills/wiki-lint/SKILL.md',
    ]);
    // envelope
    assert.strictEqual(c.envelope.producer, 'deep-memory');
    assert.strictEqual(c.envelope.artifact_kind, 'memory-card');
    assert.strictEqual(c.envelope.schema.name, 'memory-card');
    // envelope.provenance.source_artifacts is suite-shape {path, run_id} only;
    // deep-memory specific fields live in payload.deep_memory_provenance.
    assert.strictEqual(c.payload.deep_memory_provenance[0].artifact_kind, 'recurring-findings');
    assert.ok(
      c.envelope.provenance.source_artifacts[0].path.endsWith(
        path.join('tests', 'fixtures', 'sample-recurring-findings.json'),
      ),
    );
    // persisted to disk
    const onDisk = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', c.payload.memory_id + '.json');
    assert.ok(fs.existsSync(onDisk));
    const persisted = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
    assert.strictEqual(persisted.payload.memory_id, c.payload.memory_id);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Phase 3a.5 wiring — STEP_A_MAPPERS contains all 5 spec §7.1 mappers exactly', () => {
  const keys = Object.keys(STEP_A_MAPPERS).sort();
  assert.deepStrictEqual(keys, [
    'docs-scan',
    'evolve-insights',
    'review-recurring',
    'wiki-index',
    'work-receipt',
  ]);
  // each entry must be a function (not stale alias / undefined)
  for (const k of keys) {
    assert.strictEqual(typeof STEP_A_MAPPERS[k], 'function', `${k} mapper must be a function`);
  }
});

test('Step A: mapEvolveInsights — unions insights_for_deep_work + insights_for_deep_review', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-evolve-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-evolve-insights.json'),
      sourceKind: 'evolve-insights',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // 1 insight in each of the two arrays → 2 cards
    assert.strictEqual(cards.length, 2);
    const work = cards.find((c) => c.payload.tags.includes('for-deep-work'));
    const review = cards.find((c) => c.payload.tags.includes('for-deep-review'));
    assert.ok(work, 'card with for-deep-work tag present');
    assert.ok(review, 'card with for-deep-review tag present');
    assert.strictEqual(work.payload.memory_type, 'experiment-outcome');
    assert.match(work.payload.title, /early_termination_on_diverging_loss/);
    // claim source is the suggestion (most actionable)
    assert.match(work.payload.claim, /Add early termination guard/);
    // evidence_summary mixes evidence string + source_archive_ids (max 5)
    assert.ok(work.payload.evidence_summary.length >= 2);
    assert.ok(work.payload.evidence_summary.includes('arch-2026-05-01-A'));
    // recommended_action gets the suggestion
    assert.strictEqual(work.payload.recommended_action[0], work.payload.claim);
    // applicability is empty (no project_signature in real shape)
    assert.deepStrictEqual(work.payload.applicability, []);
    // confidence default 0.5 (no q_delta in real shape)
    assert.strictEqual(work.payload.confidence, 0.5);
    // review insight gets the other tag
    assert.deepStrictEqual(review.payload.tags, ['evolve', 'for-deep-review']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mapEvolveInsights returns empty array for missing payload sub-arrays (no F1 violation)', () => {
  const result = mapEvolveInsights({}, { id: 'src_0' });
  assert.deepStrictEqual(result, []);
});

test('Step A: mapWorkReceipt — Option A (1 card per session-receipt), outcome=merge → pattern', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-work-'));
  try {
    const success = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-session-receipt-success.json'),
      sourceKind: 'work-receipt',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.strictEqual(success.length, 1, 'Option A: 1 card per session-receipt');
    const s = success[0];
    assert.strictEqual(s.payload.memory_type, 'pattern', 'outcome=merge → pattern');
    assert.match(s.payload.claim, /^Pattern: implement envelope wrap with M3 adoption/);
    assert.match(s.payload.claim, /quality 8\.7\/10/);
    assert.match(s.payload.claim, /4\/4 slices completed/);
    assert.match(s.payload.claim, /outcome=merge/);
    assert.deepStrictEqual(s.payload.evidence_summary, ['dw-2026-05-19T10-00-00-000Z']);
    assert.deepStrictEqual(s.payload.tags, ['deep-work', 'session', 'merge']);
    // confidence = quality_score / 10 = 0.87
    assert.ok(Math.abs(s.payload.confidence - 0.87) < 1e-6,
      `expected confidence ~0.87, got ${s.payload.confidence}`);

    const failure = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-session-receipt-failure.json'),
      sourceKind: 'work-receipt',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.strictEqual(failure.length, 1);
    const f = failure[0];
    assert.strictEqual(f.payload.memory_type, 'failure-case', 'outcome=discard → failure-case');
    assert.match(f.payload.claim, /^Failure: FTS5 upsert lock window experiment/);
    assert.match(f.payload.claim, /quality 2\.1\/10/);
    assert.match(f.payload.claim, /outcome=discard/);
    assert.deepStrictEqual(f.payload.tags, ['deep-work', 'session', 'discard']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mapWorkReceipt produces 1 card per receipt regardless of slice counts', () => {
  // Even with no slices info, a receipt with task_description still produces 1 card.
  const result = mapWorkReceipt(
    { payload: { session_id: 'sid', task_description: 'X', outcome: 'merge' } },
    { id: 'src_0' }
  );
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].memory_type, 'pattern');
});

test('Step A: mapDocsScan — flattens documents[].issues[] (nested → 1 card per issue)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-docs-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-last-scan.json'),
      sourceKind: 'docs-scan',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // 1 document with 2 issues → 2 cards
    assert.strictEqual(cards.length, 2);
    const dead = cards.find((c) => c.payload.title.startsWith('dead-reference'));
    assert.ok(dead, 'dead-reference card present');
    assert.strictEqual(dead.payload.memory_type, 'coding-style');
    assert.match(dead.payload.claim, /dead-reference at CLAUDE\.md:42 — git rename detected/);
    assert.deepStrictEqual(dead.payload.evidence_summary, ['CLAUDE.md:42']);
    assert.strictEqual(dead.payload.applicability[0].value, 'category=auto-fix');
    assert.deepStrictEqual(dead.payload.recommended_action, ['remove reference or restore file']);
    // tags include severity now too
    assert.ok(dead.payload.tags.includes('deep-docs'));
    assert.ok(dead.payload.tags.includes('auto-fix'));
    assert.ok(dead.payload.tags.includes('high'));
    // confidence severity-mapped: high=0.7
    assert.strictEqual(dead.payload.confidence, 0.7);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mapDocsScan handles missing line number gracefully (location = path only)', () => {
  const result = mapDocsScan(
    {
      payload: {
        documents: [
          { path: 'a.md', issues: [{ type: 'orphan', category: 'audit-only', severity: 'low' }] },
        ],
      },
    },
    { id: 'src_0' }
  );
  assert.strictEqual(result.length, 1);
  // No line → location is just the path
  assert.strictEqual(result[0].claim, 'orphan at a.md');
  assert.deepStrictEqual(result[0].evidence_summary, ['a.md']);
  // severity=low → confidence 0.3
  assert.strictEqual(result[0].confidence, 0.3);
});

test('Step A: mapWikiIndex — ADR-tagged wiki pages → architecture-decision (non-ADR filtered)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-wiki-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-wiki-index.json'),
      sourceKind: 'wiki-index',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // 3 pages in fixture: 2 ADR + 1 non-ADR → 2 cards
    assert.strictEqual(cards.length, 2);
    const c1 = cards[0];
    assert.strictEqual(c1.payload.memory_type, 'architecture-decision');
    assert.strictEqual(
      c1.payload.claim,
      'Suite envelope additionalProperties:false; deep-memory specific fields move to payload.deep_memory_provenance'
    );
    assert.deepStrictEqual(c1.payload.evidence_summary, ['pages/adr/0001-envelope-option-b.md']);
    assert.deepStrictEqual(c1.payload.tags, ['wiki', 'adr']);
    assert.strictEqual(c1.payload.confidence, 0.7);
    // second ADR has no decision_summary → claim falls back to title (F1 never empty)
    const c2 = cards[1];
    assert.strictEqual(
      c2.payload.claim,
      'ADR-0002 lock strategy (no decision_summary — falls back to title)'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F1: empty-claim drafts are quarantined to <memoryRoot>/.quarantine/empty-claim/<run_id>.json (not silently dropped)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quar-'));
  try {
    // sample-recurring-findings.json has 1 valid finding + 1 empty-description finding (F1 fail)
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1, '1 valid finding survives F1');
    // run_id = '01j_recur_fixture_0001' from fixture envelope
    const quarFile = path.join(tmp, '.quarantine', 'empty-claim', '01j_recur_fixture_0001.json');
    assert.ok(fs.existsSync(quarFile), 'quarantine file written');
    const q = JSON.parse(fs.readFileSync(quarFile, 'utf8'));
    assert.strictEqual(q.rejected_count, 1);
    assert.strictEqual(q.run_id, '01j_recur_fixture_0001');
    assert.strictEqual(q.source.artifact_kind, 'recurring-findings');
    assert.strictEqual(q.rejected[0].memory_type, 'failure-case');
    // sanity — the rejected one has empty evidence_summary (no example_files)
    assert.deepStrictEqual(q.rejected[0].evidence_summary, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('F1: harvest with NO violations leaves quarantine directory untouched', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-noquar-'));
  try {
    await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-evolve-insights.json'),
      sourceKind: 'evolve-insights',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.ok(!fs.existsSync(path.join(tmp, '.quarantine')), 'no quarantine dir when F1 passes for all');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('passesF1 + partitionByF1 — pure unit checks', () => {
  assert.strictEqual(passesF1({ claim: 'a', title: 'b', evidence_summary: ['e'] }), true);
  assert.strictEqual(passesF1({ claim: '', title: 'b', evidence_summary: ['e'] }), false);
  assert.strictEqual(passesF1({ claim: 'a', title: '', evidence_summary: ['e'] }), false);
  assert.strictEqual(passesF1({ claim: 'a', title: 'b', evidence_summary: [] }), false);
  assert.strictEqual(passesF1({ claim: 'a', title: 'b' }), false);
  const { kept, rejected } = partitionByF1([
    { claim: 'a', title: 'b', evidence_summary: ['e'] },
    { claim: '', title: 'b', evidence_summary: ['e'] },
  ]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(rejected.length, 1);
});

test('mapWikiIndex filters out pages with frontmatter.adr !== true', () => {
  const result = mapWikiIndex(
    {
      payload: {
        pages: [
          { title: 'plain', path: 'plain.md', frontmatter: {} },
          { title: 'truthy not-true', path: 'tt.md', frontmatter: { adr: 'yes' } },
        ],
      },
    },
    { id: 'src_0' }
  );
  assert.deepStrictEqual(result, [], 'only strict `=== true` survives the filter');
});

test('harvest throws on unknown sourceKind', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-harv-'));
  try {
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
        sourceKind: 'unknown-kind',
        memoryRoot: tmp,
        projectId: 'proj_aaaaaaaaaaaa',
        skipDistillStepB: true,
      }),
      /Unknown sourceKind/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
