'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const FIXTURE = path.join(__dirname, 'fixtures/sample-recurring-findings.json');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lease-leak-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

test('ITEM-5-r2: lease file is removed even when acquire() throws StaleLockError', async () => {
  const tmp = mkRoot();
  try {
    // Plant a STALE lock: write metadata.json with created_at older than 5 min
    const lockDir = path.join(tmp, '.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const staleCreatedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
    fs.writeFileSync(
      path.join(lockDir, 'metadata.json'),
      JSON.stringify({ pid: 99999, host: 'ghost', created_at: staleCreatedAt, operation: 'harvest' })
    );

    const leasePath = path.join(tmp, '.leases', 'proj_222222222222.lease');

    // harvestArtifact should throw due to StaleLockError
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: FIXTURE,
        sourceKind: 'review-recurring',
        memoryRoot: tmp,
        projectId: 'proj_222222222222',
        skipDistillStepB: true,
      }),
      (e) => {
        assert.strictEqual(e.code, 'STALE_LOCK', `Expected STALE_LOCK, got: ${e.code} — ${e.message}`);
        return true;
      }
    );

    // After the throw, the lease file must NOT exist (no leak)
    assert.ok(
      !fs.existsSync(leasePath),
      `Lease file should be cleaned up after StaleLockError, but found: ${leasePath}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
