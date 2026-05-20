'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { writeJsonAtomic } = require('../scripts/lib/atomic-write');

test('ITEM-4: re-harvest preserves status/status_history/feedback/created_at from existing card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-merge-'));
  try {
    // Step (a): first harvest
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1);
    const card = cards[0];
    const memoryId = card.payload.memory_id;
    const cardPath = path.join(tmp, 'cards', 'failure-case', 'proj_test', memoryId + '.json');
    assert.ok(fs.existsSync(cardPath));

    const firstLastSeen = card.payload.last_seen_at;
    const firstCreatedAt = card.payload.created_at;

    // Step (b): mutate the persisted card to simulate post-promote / post-audit state
    const onDisk = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    const promotedAt = new Date(Date.now() - 1000).toISOString();
    onDisk.payload.status = 'validated';
    onDisk.payload.status_history = [
      { from: 'candidate', to: 'validated', at: promotedAt, by: 'manual:test' },
    ];
    onDisk.payload.feedback = { accepted_count: 3, rejected_count: 0, inaccurate_count: 0 };
    writeJsonAtomic(cardPath, onDisk);

    // Small delay to ensure last_seen_at will be strictly newer
    await new Promise((r) => setTimeout(r, 10));

    // Step (c): re-harvest same fixture with skipDistillStepB
    const cards2 = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards2.length, 1);

    // Step (d): verify preserved fields
    const afterMerge = JSON.parse(fs.readFileSync(cardPath, 'utf8'));

    assert.strictEqual(
      afterMerge.payload.status,
      'validated',
      'status should be preserved from existing card'
    );
    assert.strictEqual(
      afterMerge.payload.status_history.length,
      1,
      'status_history length should be preserved'
    );
    assert.strictEqual(
      afterMerge.payload.status_history[0].by,
      'manual:test',
      'status_history entry should be preserved'
    );
    assert.strictEqual(
      afterMerge.payload.feedback.accepted_count,
      3,
      'feedback.accepted_count should be preserved'
    );

    // created_at should be preserved from first harvest
    assert.strictEqual(
      afterMerge.payload.created_at,
      firstCreatedAt,
      'created_at should be preserved from original card'
    );

    // last_seen_at should be UPDATED (newer than the original)
    assert.ok(
      new Date(afterMerge.payload.last_seen_at) > new Date(firstLastSeen),
      `last_seen_at should be updated: got ${afterMerge.payload.last_seen_at}, original was ${firstLastSeen}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ITEM-4: first harvest (no existing card) writes fresh card normally', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-merge-fresh-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_test',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1);
    const c = cards[0];
    // Fresh card starts as candidate with empty history
    assert.strictEqual(c.payload.status, 'candidate');
    assert.deepStrictEqual(c.payload.status_history, []);
    assert.strictEqual(c.payload.feedback.accepted_count, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
