'use strict';
// ITEM-7-r3: When a card is re-harvested into the global scope (because an existing
// global file was found during ITEM-1-r2 read-before-write), the FTS row's project_id
// must be '' (empty string) to match the global scope, not the harvesting project's id.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-recurring-findings.json');

test('ITEM-7-r3: re-harvest of globally-promoted card sets FTS row project_id to empty string', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-global-pid-'));
  try {
    // Step 1: harvest as proj_eeeeeeeeeeee to get a card with a known memory_id
    const cardsA = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmpRoot,
      projectId: 'proj_eeeeeeeeeeee',
      skipDistillStepB: true,
    });
    assert.strictEqual(cardsA.length, 1, 'Fixture should produce 1 card');
    const memId = cardsA[0].payload.memory_id;
    const memType = cardsA[0].payload.memory_type;

    // Step 2: promote the card — move local file to global dir + set privacy_level='global'
    const localPath = path.join(tmpRoot, 'cards', memType, 'proj_eeeeeeeeeeee', memId + '.json');
    const globalDir = path.join(tmpRoot, 'cards', memType, 'global');
    const globalPath = path.join(globalDir, memId + '.json');
    fs.mkdirSync(globalDir, { recursive: true });
    const localCard = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    localCard.payload.privacy_level = 'global';
    fs.writeFileSync(globalPath, JSON.stringify(localCard));
    // Remove local so the only copy is global
    fs.unlinkSync(localPath);

    // Step 3: harvest the same fixture as proj_ffffffffffff — ITEM-1-r2 detects global file,
    // writes to global dir with privacy_level preserved. FTS row must get project_id=''.
    const cardsB = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmpRoot,
      projectId: 'proj_ffffffffffff',
      skipDistillStepB: true,
    });
    assert.strictEqual(cardsB.length, 1, 'Re-harvest should produce 1 card');

    // Step 4: read the FTS row and check project_id
    const idxPath = path.join(tmpRoot, 'indexes', 'lexical.sqlite');
    assert.ok(fs.existsSync(idxPath), 'FTS index must exist');
    const idx = openIndex(idxPath);
    try {
      const row = idx.db.prepare('SELECT project_id, privacy_level FROM cards WHERE memory_id = ?').get(memId);
      assert.ok(row, `FTS row for ${memId} must exist`);
      assert.strictEqual(row.privacy_level, 'global', 'FTS row privacy_level must be global');
      assert.strictEqual(row.project_id, '', `FTS row project_id must be '' for global card, got '${row.project_id}'`);
    } finally {
      idx.db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ITEM-7-r3: local card upsert still gets correct project_id (regression guard)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-local-pid-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmpRoot,
      projectId: 'proj_111111111111',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1);
    const memId = cards[0].payload.memory_id;

    const idxPath = path.join(tmpRoot, 'indexes', 'lexical.sqlite');
    const idx = openIndex(idxPath);
    try {
      const row = idx.db.prepare('SELECT project_id, privacy_level FROM cards WHERE memory_id = ?').get(memId);
      assert.ok(row, 'FTS row must exist for local card');
      assert.strictEqual(row.privacy_level, 'local', 'Local card must have privacy_level=local');
      assert.strictEqual(row.project_id, 'proj_111111111111', 'Local card FTS row must have the harvesting project_id');
    } finally {
      idx.db.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
