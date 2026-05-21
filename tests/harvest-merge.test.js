'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { writeJsonAtomic } = require('../scripts/lib/atomic-write');
const { promoteCard } = require('../scripts/audit');

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

test('ITEM-1-r2: re-harvest after promote does not shadow the global card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-merge-global-'));
  try {
    // Step 1: harvest fixture → 1 card under proj_A
    const cards = await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_A',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1);
    const memoryId = cards[0].payload.memory_id;
    const localPath = path.join(tmp, 'cards', 'failure-case', 'proj_A', memoryId + '.json');
    assert.ok(fs.existsSync(localPath), 'local card exists after first harvest');

    // Step 2: promoteCard with projectId:'proj_A' → file moves to cards/failure-case/global/<id>.json
    await promoteCard(memoryId, { memoryRoot: tmp, projectId: 'proj_A' });
    const globalPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    assert.ok(fs.existsSync(globalPath), 'global card exists after promote');
    assert.ok(!fs.existsSync(localPath), 'local card removed after promote');

    const beforeGlobal = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    assert.strictEqual(beforeGlobal.payload.privacy_level, 'global');
    const beforeLastSeen = beforeGlobal.payload.last_seen_at;

    // Small delay to ensure last_seen_at will be strictly newer
    await new Promise((r) => setTimeout(r, 10));

    // Step 3: harvest the SAME fixture again under projectId:'proj_B'
    await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_B',
      skipDistillStepB: true,
    });

    // Step 4: Assert NO file at cards/failure-case/proj_B/<id>.json
    const projBPath = path.join(tmp, 'cards', 'failure-case', 'proj_B', memoryId + '.json');
    assert.ok(!fs.existsSync(projBPath), 'no shadow file created under proj_B');

    // The global file STILL exists and was UPDATED (last_seen_at refreshed)
    assert.ok(fs.existsSync(globalPath), 'global file still exists');
    const afterGlobal = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
    assert.strictEqual(afterGlobal.payload.privacy_level, 'global', 'privacy_level still global');
    assert.ok(
      new Date(afterGlobal.payload.last_seen_at) > new Date(beforeLastSeen),
      `last_seen_at should be updated: got ${afterGlobal.payload.last_seen_at}, before was ${beforeLastSeen}`
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
