'use strict';
// ITEM-5-r3: audit.run must run detectStaleLocks BEFORE acquiring the global lock.
// When the lock is stale, audit.run should:
//   (a) still surface stale_locks.locks[0].stale === true in the result
//   (b) record skipped_due_to_lock on transitions (couldn't acquire lock)
//   (c) write latest-audit.json with both (a) and (b)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../scripts/audit');

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-stallock-order-')); }

function plantStaleLock(memoryRoot) {
  // Plant a lock that is 6 minutes old — STALE_MS is 5 min, so this is stale.
  const lockPath = path.join(memoryRoot, '.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  const createdAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(lockPath, 'metadata.json'),
    JSON.stringify({ pid: 99999, host: 'test-host', created_at: createdAt, operation: 'harvest' })
  );
  return lockPath;
}

test('ITEM-5-r3: audit.run with stale lock — stale lock surfaces in report + transitions skipped', async () => {
  const tmp = mkRoot();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-stallock-'));
  try {
    plantStaleLock(tmp);

    const result = await run({ memoryRoot: tmp, projectDir });

    // (a) stale lock must be detected and reported
    assert.ok(Array.isArray(result.stale_locks.locks), 'stale_locks.locks must be an array');
    assert.strictEqual(result.stale_locks.locks.length, 1, 'exactly one lock detected');
    assert.strictEqual(result.stale_locks.locks[0].stale, true, 'lock must be reported as stale');

    // (b) transitions must include skipped_due_to_lock (lock acquisition failed)
    assert.ok(
      'skipped_due_to_lock' in result.transitions,
      'transitions.skipped_due_to_lock must be set when lock acquisition fails'
    );
    assert.ok(result.transitions.skipped_due_to_lock, 'skipped_due_to_lock must be truthy');

    // (c) latest-audit.json on disk must reflect both (a) and (b)
    const auditPath = path.join(projectDir, '.deep-memory', 'latest-audit.json');
    assert.ok(fs.existsSync(auditPath), 'latest-audit.json must be written');
    const onDisk = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    assert.strictEqual(onDisk.stale_locks.locks[0].stale, true, 'on-disk stale_locks must show stale');
    assert.ok('skipped_due_to_lock' in onDisk.transitions, 'on-disk transitions must have skipped_due_to_lock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('ITEM-5-r3: audit.run without stale lock — normal path unchanged', async () => {
  const tmp = mkRoot();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-nolock-'));
  try {
    // No pre-planted lock — audit should acquire freely and run transitions normally.
    const result = await run({ memoryRoot: tmp, projectDir });

    // No stale locks
    assert.strictEqual(result.stale_locks.locks.filter((l) => l.stale).length, 0,
      'no stale locks in clean root');

    // Transitions ran normally (no skipped_due_to_lock)
    assert.ok(!('skipped_due_to_lock' in result.transitions) || !result.transitions.skipped_due_to_lock,
      'transitions should not have skipped_due_to_lock in normal path');

    // latest-audit.json written
    const auditPath = path.join(projectDir, '.deep-memory', 'latest-audit.json');
    assert.ok(fs.existsSync(auditPath), 'latest-audit.json must be written even in clean case');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
