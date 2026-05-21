'use strict';
/**
 * Sibling-shape invariant smoke test.
 *
 * v0.1.0 shipped with mapper expectations from spec §7.1 IDEAL shape; sibling
 * plugins' actual emit shape was never cross-checked. The result: 4 of 5 Step A
 * mappers silently produced 0 cards. v0.1.2 realigns mappers to sibling-real
 * shapes — THIS test exists to make future regressions immediately visible.
 *
 * For each source kind, this test reads the sibling repo's actual fixture (NOT
 * our local fixture) and asserts harvestArtifact produces ≥ 1 card. If a
 * sibling changes their payload shape again, this test will fail loud and clear.
 *
 * SKIP rule: if a sibling repo isn't checked out next to deep-memory, that
 * mapper's smoke check is skipped (logged, not failed). CI runners that clone
 * the whole suite get full coverage; local dev with a partial checkout gets
 * partial coverage.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const SIBLING_FIXTURES = [
  {
    kind: 'review-recurring',
    fixture: '../../deep-review/tests/fixtures/sample-recurring-findings.json',
    minCards: 1,
  },
  {
    kind: 'evolve-insights',
    fixture: '../../deep-evolve/tests/fixtures/sample-evolve-insights.json',
    minCards: 1,
  },
  {
    kind: 'work-receipt',
    fixture: '../../deep-work/tests/fixtures/sample-session-receipt.json',
    minCards: 1,
  },
  {
    kind: 'docs-scan',
    fixture: '../../deep-docs/tests/fixtures/sample-last-scan.json',
    minCards: 1,
  },
];

// v0.1.3 — env-gated hard-fail. When DEEP_MEMORY_FULL_SUITE=1 is set (CI runners
// that clone the full sibling suite, or developers intentionally exercising
// drift detection), missing sibling fixtures fail the test loudly instead of
// silently skipping. Round 1 review-respond — Opus 🟡 #3 fix.
const FULL_SUITE_MODE = process.env.DEEP_MEMORY_FULL_SUITE === '1';

for (const { kind, fixture, minCards } of SIBLING_FIXTURES) {
  const absFixture = path.resolve(__dirname, fixture);
  const exists = fs.existsSync(absFixture);
  const skipReason = !exists
    ? `sibling fixture not found at ${path.relative(process.cwd(), absFixture)} (skipping — not a regression, just a partial checkout)`
    : null;

  test(`sibling-shape smoke: ${kind} produces ≥${minCards} card(s) from real sibling fixture`, async (t) => {
    if (skipReason) {
      if (FULL_SUITE_MODE) {
        assert.fail(
          `DEEP_MEMORY_FULL_SUITE=1 is set but ${kind} fixture is missing at ` +
          `${absFixture}. Either clone the sibling repo at the expected path or unset the env var.`
        );
      }
      t.skip(skipReason);
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dm-smoke-${kind}-`));
    try {
      const cards = await harvestArtifact({
        artifactPath: absFixture,
        sourceKind: kind,
        memoryRoot: tmp,
        projectId: 'proj_aaaaaaaaaaaa',
        skipDistillStepB: true,
      });
      assert.ok(
        cards.length >= minCards,
        `Expected ≥${minCards} card(s) from ${kind} sibling fixture, got ${cards.length}. ` +
          `This means the sibling's payload shape changed and our mapper no longer matches. ` +
          `Fixture: ${absFixture}`
      );
      // All produced cards must satisfy F1 (claim/title/evidence_summary non-empty)
      for (const c of cards) {
        assert.ok(c.payload.claim.length > 0, `F1: ${kind} card claim must be non-empty`);
        assert.ok(c.payload.title.length > 0, `F1: ${kind} card title must be non-empty`);
        assert.ok(c.payload.evidence_summary.length > 0, `F1: ${kind} card evidence non-empty`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('sibling-shape smoke: full-suite check writes ≥4 cards across all 4 sibling-real fixtures', async (t) => {
  // Aggregate smoke — across all 4 sibling kinds, we should produce at least
  // 4 cards. If any sibling repo is missing, the count threshold is lowered
  // proportionally so partial-checkout dev still works.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-smoke-all-'));
  try {
    let total = 0;
    let available = 0;
    for (const { kind, fixture } of SIBLING_FIXTURES) {
      const absFixture = path.resolve(__dirname, fixture);
      if (!fs.existsSync(absFixture)) continue;
      available += 1;
      const cards = await harvestArtifact({
        artifactPath: absFixture,
        sourceKind: kind,
        memoryRoot: tmp,
        projectId: 'proj_aaaaaaaaaaaa',
        skipDistillStepB: true,
      });
      total += cards.length;
    }
    if (available === 0) {
      if (FULL_SUITE_MODE) {
        assert.fail(
          'DEEP_MEMORY_FULL_SUITE=1 is set but no sibling repos are checked out. ' +
          'Either clone the sibling repos at ../deep-{review,evolve,work,docs}/ or unset the env var.'
        );
      }
      t.skip('no sibling repos checked out next to deep-memory — aggregate smoke skipped');
      return;
    }
    if (FULL_SUITE_MODE && available < SIBLING_FIXTURES.length) {
      assert.fail(
        `DEEP_MEMORY_FULL_SUITE=1 expects all ${SIBLING_FIXTURES.length} sibling fixtures, ` +
        `found only ${available}.`
      );
    }
    assert.ok(
      total >= available,
      `Expected ≥${available} cards across ${available} sibling fixture(s), got ${total}. ` +
        `At least one mapper produced 0 cards — likely shape drift.`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
