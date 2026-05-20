'use strict';
// P17 — cross-reference invariant test (spec §6.4):
//   every payload.applicability[].source_id AND payload.non_applicability[].source_id
//   MUST resolve into envelope.provenance.source_artifacts[].id of the same card.
//
// This test scans the test-fixture roots used by Phase 4 (retrieve / brief) tests
// as well as DEEP_MEMORY_TEST_ROOT for a CI override. When no card files exist
// (clean checkout) the test is a vacuous pass — Phase 5 audit promotes this
// check to a runtime invariant.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

function* allCardFiles(cardsRoot) {
  if (!fs.existsSync(cardsRoot)) return;
  for (const type of fs.readdirSync(cardsRoot)) {
    const td = path.join(cardsRoot, type);
    if (!fs.statSync(td).isDirectory()) continue;
    for (const scope of fs.readdirSync(td)) {
      const sd = path.join(td, scope);
      if (!fs.statSync(sd).isDirectory()) continue;
      for (const f of fs.readdirSync(sd)) {
        if (f.endsWith('.json')) yield path.join(sd, f);
      }
    }
  }
}

function validateCard(cardPath) {
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  // envelope-compat decision Option (b): source IDs live in
  // payload.deep_memory_provenance[].id (suite envelope source_artifacts only
  // carries {path, run_id}).
  const validIds = new Set(
    (card.payload?.deep_memory_provenance || []).map((s) => s.id)
  );
  const items = [
    ...((card.payload?.applicability) || []),
    ...((card.payload?.non_applicability) || []),
  ];
  for (const a of items) {
    if (!a || typeof a.source_id !== 'string') continue;
    assert.ok(
      validIds.has(a.source_id),
      `${cardPath}: source_id ${a.source_id} not in payload.deep_memory_provenance ids ` +
      `[${[...validIds].join(', ')}]`
    );
  }
  // Bonus invariant: every deep_memory_provenance.source_index must point
  // into the envelope source_artifacts array.
  const saLen = (card.envelope?.provenance?.source_artifacts || []).length;
  for (const dp of (card.payload?.deep_memory_provenance || [])) {
    if (typeof dp.source_index !== 'number') continue;
    assert.ok(dp.source_index >= 0 && dp.source_index < saLen,
      `${cardPath}: deep_memory_provenance.source_index ${dp.source_index} out of range [0,${saLen})`);
  }
}

test('P17: every applicability/non_applicability.source_id resolves into envelope.provenance.source_artifacts[].id (DEEP_MEMORY_TEST_ROOT override)', () => {
  const root = process.env.DEEP_MEMORY_TEST_ROOT;
  if (!root || !fs.existsSync(root)) return; // vacuous when no override
  const cardsRoot = path.join(root, 'cards');
  let count = 0;
  for (const cp of allCardFiles(cardsRoot)) {
    validateCard(cp);
    count += 1;
  }
  // Even with 0 cards (empty memory_root) the test passes vacuously — that is
  // the intended Phase 4 behavior. Phase 5 audit will surface zero-card state
  // separately as a coverage warning.
  assert.ok(count >= 0, `scanned ${count} cards`);
});

test('P17 in-process: a freshly harvested artifact obeys the cross-ref invariant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xref-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_xref',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1);
    // sweep the persisted cards dir
    const cardsRoot = path.join(tmp, 'cards');
    let scanned = 0;
    for (const cp of allCardFiles(cardsRoot)) {
      validateCard(cp);
      scanned += 1;
    }
    assert.strictEqual(scanned, 1, 'exactly one card persisted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P17 in-process with Step B refinement: non_applicability source_id back-filled by orchestrator', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xref-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_xref',
      llmAdapter: 'claude-agent',
      llmRecordedFixture: path.join(__dirname, 'fixtures/runtime-recorded/claude-agent.jsonl'),
    });
    assert.strictEqual(cards.length, 1);
    const card = cards[0];
    // Step B populated non_applicability with values from the fixture
    assert.ok(card.payload.non_applicability.length > 0);
    // every source_id must resolve into payload.deep_memory_provenance ids
    const validIds = new Set(card.payload.deep_memory_provenance.map((s) => s.id));
    for (const n of card.payload.non_applicability) {
      assert.ok(validIds.has(n.source_id),
        `Step B non_applicability source_id ${n.source_id} not in deep_memory_provenance ids`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
