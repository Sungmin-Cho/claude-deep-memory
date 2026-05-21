'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact, mergeStepB } = require('../scripts/harvest');

const RECURRING_FIXTURE = path.join(__dirname, 'fixtures/sample-recurring-findings.json');
const CLAUDE_FIXTURE = path.join(__dirname, 'fixtures/runtime-recorded/claude-agent.jsonl');

test('distill-golden: recurring-findings → failure-case with Step B refinement (claude-agent recorded)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gold-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: RECURRING_FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      llmAdapter: 'claude-agent',
      llmRecordedFixture: CLAUDE_FIXTURE,
    });
    assert.strictEqual(cards.length, 1, '1 valid finding (other is F1-quarantined)');
    const c = cards[0];
    // Step A baselines preserved
    assert.deepStrictEqual(c.payload.tags, ['manifest', 'critical']);
    assert.ok(c.payload.evidence_summary.length > 0);
    assert.strictEqual(c.payload.applicability[0].value, 'category=manifest');
    // Step A claim is the description verbatim ("Codex skill discovery silently fails …").
    // Step B refines via the recorded fixture (claim_refined).
    assert.match(c.payload.claim, /validate strictly|skill discovery silently fails/);
    // Step B filled previously-empty slots
    assert.ok(c.payload.search_keywords.length > 0, 'Step B populates search_keywords');
    assert.ok(c.payload.recommended_action.length > 0, 'Step B populates recommended_action');
    assert.ok(c.payload.non_applicability.length > 0, 'Step B populates non_applicability');
    // source_id back-filled by orchestrator (schema requires it on non_applicability items)
    for (const n of c.payload.non_applicability) {
      assert.strictEqual(n.source_id, 'src_0');
      assert.ok(n.confidence >= 0 && n.confidence <= 1);
    }
    // confidence boosted from 0.5 default to 0.7 (capped at 1)
    assert.ok(c.payload.confidence >= 0.7 - 1e-9 && c.payload.confidence <= 1,
      `expected confidence in [0.7,1], got ${c.payload.confidence}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('distill: Step B failure (no fixture, no live) → candidate fallback (Step A only)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gold-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: RECURRING_FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      llmAdapter: 'claude-agent',
      llmRecordedFixture: null, // forces ADAPTER_NOT_WIRED
    });
    assert.strictEqual(cards.length, 1);
    const c = cards[0];
    // Step A claim survived (no Step B refinement) — full description verbatim
    assert.strictEqual(
      c.payload.claim,
      'Codex skill discovery silently fails on invalid frontmatter — empty description or trailing colon yields zero-match.'
    );
    // Step B-derived fields stay empty
    assert.deepStrictEqual(c.payload.search_keywords, []);
    assert.deepStrictEqual(c.payload.recommended_action, []);
    assert.deepStrictEqual(c.payload.non_applicability, []);
    // confidence stays at Step A default (0.5)
    assert.strictEqual(c.payload.confidence, 0.5);
    assert.strictEqual(c.payload.status, 'candidate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('distill: skipDistillStepB:true skips Step B entirely (back-compat path)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gold-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: RECURRING_FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true, // legacy callers
      llmRecordedFixture: CLAUDE_FIXTURE, // would normally refine — but skipped
    });
    assert.strictEqual(cards.length, 1);
    const c = cards[0];
    // No Step B fields populated
    assert.deepStrictEqual(c.payload.search_keywords, []);
    assert.deepStrictEqual(c.payload.recommended_action, []);
    assert.strictEqual(c.payload.confidence, 0.5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mergeStepB respects spec §7.2 invariant — does NOT clobber Step A non-empty fields', () => {
  const draft = {
    memory_type: 'failure-case',
    title: 'A',
    claim: 'Step A claim — different from title',
    evidence_summary: ['ev'],
    applicability: [],
    non_applicability: [{ value: 'pre-existing', source_id: 'src_0', confidence: 0.9 }],
    recommended_action: ['pre-existing action'],
    search_keywords: ['pre-existing'],
    tags: ['t'],
    confidence: 0.3,
  };
  const stepB = {
    claim_refined: 'Step B refined claim',
    non_applicability: [{ value: 'new', confidence: 0.5 }],
    recommended_action: ['new action'],
    search_keywords: ['new'],
  };
  mergeStepB(draft, stepB, { id: 'src_0' });
  // ITEM-6-r2: claim IS refined by Step B regardless of whether it differs from title.
  // spec §7.2 — Step B refines ALL claims when claim_refined is non-empty.
  assert.strictEqual(draft.claim, 'Step B refined claim');
  // non_applicability preserved (Step A had pre-existing values)
  assert.strictEqual(draft.non_applicability[0].value, 'pre-existing');
  assert.strictEqual(draft.recommended_action[0], 'pre-existing action');
  assert.strictEqual(draft.search_keywords[0], 'pre-existing');
  // confidence boost
  assert.ok(Math.abs(draft.confidence - 0.5) < 1e-9, `expected 0.5, got ${draft.confidence}`);
});

test('mergeStepB on null stepB is a no-op', () => {
  const draft = { confidence: 0.4, claim: 'a', title: 'b' };
  mergeStepB(draft, null, { id: 'src_0' });
  assert.strictEqual(draft.confidence, 0.4);
  assert.strictEqual(draft.claim, 'a');
});
