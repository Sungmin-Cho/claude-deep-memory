'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { promoteCard } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-promote-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

async function harvestOne(tmp) {
  const cards = await harvestArtifact({
    artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
    sourceKind: 'review-recurring',
    memoryRoot: tmp,
    projectId: 'proj_test',
    skipDistillStepB: true,
  });
  return cards[0];
}

test('Task 5.7: promoteCard moves local → global atomically + updates FTS5', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;
    const oldPath = path.join(tmp, 'cards', 'failure-case', 'proj_test', memoryId + '.json');
    assert.ok(fs.existsSync(oldPath));

    const result = await promoteCard(memoryId, { memoryRoot: tmp });
    assert.strictEqual(result.memory_id, memoryId);
    assert.strictEqual(result.previous_privacy_level, 'local');
    assert.strictEqual(result.new_privacy_level, 'global');

    // file moved
    assert.ok(!fs.existsSync(oldPath), 'local copy removed');
    const newPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    assert.ok(fs.existsSync(newPath), 'global copy created');

    // payload updated + status_history grew
    const updated = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    assert.strictEqual(updated.payload.privacy_level, 'global');
    assert.strictEqual(updated.payload.status_history.length, 1);
    assert.strictEqual(updated.payload.status_history[0].by, 'manual:promote');

    // FTS5 upsert: search returns the global card from a fresh project
    const { openIndex, search, closeIndex } = require('../scripts/lib/fts-index');
    const idx = openIndex(path.join(tmp, 'indexes', 'lexical.sqlite'));
    try {
      const rows = search(idx, 'codex skill', { topN: 5, projectId: 'proj_unrelated' });
      const ids = rows.map((r) => r.memory_id);
      assert.ok(ids.includes(memoryId), 'global card visible to other project after promote');
    } finally {
      closeIndex(idx);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.7: promoteCard on already-global card throws ALREADY_GLOBAL', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;
    await promoteCard(memoryId, { memoryRoot: tmp }); // first promotion
    await assert.rejects(
      () => promoteCard(memoryId, { memoryRoot: tmp }),
      (e) => e.code === 'ALREADY_GLOBAL'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.7: promoteCard with unknown memory_id throws NOT_FOUND', async () => {
  const tmp = mkRoot();
  try {
    await assert.rejects(
      () => promoteCard('mem_does_not_exist', { memoryRoot: tmp }),
      (e) => e.code === 'NOT_FOUND'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.7: promoteCard requires memoryId + memoryRoot', async () => {
  await assert.rejects(() => promoteCard('', { memoryRoot: '/tmp' }), /requires memoryId/);
  await assert.rejects(() => promoteCard('mem_x', {}), /requires memoryRoot/);
});

test('Task 5.7: status_history truncates at 10 after promote when already full', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;
    const cardPath = path.join(tmp, 'cards', 'failure-case', 'proj_test', memoryId + '.json');
    const onDisk = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    // bloat history to 10 entries first
    onDisk.payload.status_history = Array.from({ length: 10 }, (_, i) => ({
      from: 'candidate',
      to: 'candidate',
      at: new Date(Date.now() - (10 - i) * 1000).toISOString(),
      by: 'manual:test_' + i,
    }));
    fs.writeFileSync(cardPath, JSON.stringify(onDisk, null, 2));

    await promoteCard(memoryId, { memoryRoot: tmp });
    const newPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    const after = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    assert.strictEqual(after.payload.status_history.length, 10);
    assert.strictEqual(after.payload.status_history[9].by, 'manual:promote');
    assert.strictEqual(after.payload.status_history[0].by, 'manual:test_1',
      'oldest entry test_0 dropped to make room');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
