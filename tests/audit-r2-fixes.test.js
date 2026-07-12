'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { harvestArtifact } = require('../scripts/harvest');
const { writeValidProjectProfile } = require('./helpers/project-profile-fixtures');

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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-audit-r2-project-'));
  try {
    const profile = writeValidProjectProfile(projectRoot);
    const projectId = profile.project_id;
    // Harvest once under the trusted current v2 scope.
    const cards = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId,
      skipDistillStepB: true,
    });
    const memoryId = cards[0].payload.memory_id;

    // Copy the card into a second scope proj_dddddddddddd to create multi-scope scenario
    const srcPath = path.join(tmp, 'cards', 'failure-case', projectId, memoryId + '.json');
    const projYDir = path.join(tmp, 'cards', 'failure-case', 'proj_0123456789abcdef');
    fs.mkdirSync(projYDir, { recursive: true });
    const projYPath = path.join(projYDir, memoryId + '.json');
    fs.copyFileSync(srcPath, projYPath);

    // The CLI treats --project as an equality assertion after resolving the
    // trusted profile; it is never a raw scope override.
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/audit.js'), '--promote', memoryId, '--project', projectId],
      { cwd: projectRoot, env: { ...process.env, DEEP_MEMORY_ROOT: tmp }, encoding: 'utf8' }
    );

    assert.strictEqual(result.status, 0, `audit.js exited non-zero: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.new_privacy_level, 'global', 'promoted card is global');
    const auditDir = path.join(tmp, 'audit-log');
    const auditLines = fs.readdirSync(auditDir)
      .flatMap((name) => fs.readFileSync(path.join(auditDir, name), 'utf8').split(/\r?\n/).filter(Boolean))
      .map(JSON.parse);
    assert.deepEqual(auditLines.map((entry) => entry.kind), ['mutation-consent', 'promote']);
    assert.equal(auditLines[0].at, auditLines[1].at);
    assert.equal(auditLines[0].payload.args.project_id, projectId);
    assert.equal(auditLines[1].payload.memory_id, memoryId);

    // Global file present
    const globalPath = path.join(tmp, 'cards', 'failure-case', 'global', memoryId + '.json');
    assert.ok(fs.existsSync(globalPath), 'global file created');

    // Trusted current-project local file removed.
    assert.ok(!fs.existsSync(srcPath), 'current v2 project local file removed');

    // proj_dddddddddddd untouched
    assert.ok(fs.existsSync(projYPath), 'proj_dddddddddddd file untouched');
    const projYCard = JSON.parse(fs.readFileSync(projYPath, 'utf8'));
    assert.strictEqual(projYCard.payload.privacy_level, 'local', 'proj_dddddddddddd card still local');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
