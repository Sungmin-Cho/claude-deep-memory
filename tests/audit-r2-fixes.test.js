'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { harvestArtifact } = require('../scripts/harvest');

const FIXTURE = path.join(__dirname, 'fixtures/sample-recurring-findings.json');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-audit-r2-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

test('ITEM-2-r2: audit.js --promote --project CLI passes projectId, resolves single scope, leaves other intact', async () => {
  const tmp = mkRoot();
  try {
    // Harvest once under proj_cccccccccccc
    const cards = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_cccccccccccc',
      skipDistillStepB: true,
    });
    const memoryId = cards[0].payload.memory_id;

    // Copy the card into a second scope proj_dddddddddddd to create multi-scope scenario
    const srcPath = path.join(tmp, 'cards', 'failure-case', 'proj_cccccccccccc', memoryId + '.json');
    const projYDir = path.join(tmp, 'cards', 'failure-case', 'proj_dddddddddddd');
    fs.mkdirSync(projYDir, { recursive: true });
    const projYPath = path.join(projYDir, memoryId + '.json');
    fs.copyFileSync(srcPath, projYPath);

    // Spawn: node scripts/audit.js --promote <id> --project proj_cccccccccccc
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/audit.js'), '--promote', memoryId, '--project', 'proj_cccccccccccc'],
      { env: { ...process.env, DEEP_MEMORY_ROOT: tmp }, encoding: 'utf8' }
    );

    assert.strictEqual(result.status, 0, `audit.js exited non-zero: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.new_privacy_level, 'global', 'promoted card is global');

    // Global file present
    const globalPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    assert.ok(fs.existsSync(globalPath), 'global file created');

    // proj_cccccccccccc local file removed
    assert.ok(!fs.existsSync(srcPath), 'proj_cccccccccccc local file removed');

    // proj_dddddddddddd untouched
    assert.ok(fs.existsSync(projYPath), 'proj_dddddddddddd file untouched');
    const projYCard = JSON.parse(fs.readFileSync(projYPath, 'utf8'));
    assert.strictEqual(projYCard.payload.privacy_level, 'local', 'proj_dddddddddddd card still local');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
