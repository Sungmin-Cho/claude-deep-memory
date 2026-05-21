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
    projectId: 'proj_aaaaaaaaaaaa',
    skipDistillStepB: true,
  });
  return cards[0];
}

test('Task 5.7: promoteCard moves local → global atomically + updates FTS5', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;
    const oldPath = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', memoryId + '.json');
    assert.ok(fs.existsSync(oldPath));

    // Pass explicit projectId per ITEM-5 acceptance criteria
    const result = await promoteCard(memoryId, { memoryRoot: tmp, projectId: 'proj_aaaaaaaaaaaa' });
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

// ITEM-5: Ambiguity detection tests

test('ITEM-5: promoteCard with no projectId throws AMBIGUOUS when same memory_id under 2 scopes', async () => {
  const tmp = mkRoot();
  try {
    // Harvest once to get a real card shape
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;

    // Copy the card file into a second project scope to create ambiguity
    const srcPath = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', memoryId + '.json');
    const altScopeDir = path.join(tmp, 'cards', 'failure-case', 'proj_alt');
    fs.mkdirSync(altScopeDir, { recursive: true });
    fs.copyFileSync(srcPath, path.join(altScopeDir, memoryId + '.json'));

    // Without projectId: should fail-closed with AMBIGUOUS
    await assert.rejects(
      () => promoteCard(memoryId, { memoryRoot: tmp }),
      (e) => {
        assert.strictEqual(e.code, 'AMBIGUOUS', `Expected AMBIGUOUS, got: ${e.code} — ${e.message}`);
        assert.strictEqual(e.memory_id, memoryId);
        assert.ok(Array.isArray(e.scopes) && e.scopes.length === 2, `scopes should have 2 entries: ${JSON.stringify(e.scopes)}`);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ITEM-5: promoteCard with projectId promotes only the specified scope, leaves other intact', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;

    // Create same memory_id under proj_alt as well (simulate two-project collision)
    const srcPath = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', memoryId + '.json');
    const altScopeDir = path.join(tmp, 'cards', 'failure-case', 'proj_alt');
    fs.mkdirSync(altScopeDir, { recursive: true });
    const altPath = path.join(altScopeDir, memoryId + '.json');
    fs.copyFileSync(srcPath, altPath);

    // Promote only proj_aaaaaaaaaaaa copy
    const result = await promoteCard(memoryId, { memoryRoot: tmp, projectId: 'proj_aaaaaaaaaaaa' });
    assert.strictEqual(result.new_privacy_level, 'global');

    // proj_aaaaaaaaaaaa local copy removed, global copy created
    assert.ok(!fs.existsSync(srcPath), 'proj_aaaaaaaaaaaa local copy removed');
    const globalPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    assert.ok(fs.existsSync(globalPath), 'global copy created');

    // proj_alt copy is UNTOUCHED (still local)
    assert.ok(fs.existsSync(altPath), 'proj_alt copy still exists (untouched)');
    const altCard = JSON.parse(fs.readFileSync(altPath, 'utf8'));
    assert.strictEqual(altCard.payload.privacy_level, 'local', 'proj_alt card still local');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.7: status_history truncates at 10 after promote when already full', async () => {
  const tmp = mkRoot();
  try {
    const card = await harvestOne(tmp);
    const memoryId = card.payload.memory_id;
    const cardPath = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', memoryId + '.json');
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
