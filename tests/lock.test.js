const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { acquire, release, isStale, breakLock, StaleLockError, STALE_MS } = require('../scripts/lib/lock');

test('acquire creates lock dir + metadata, release removes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-'));
  const lockPath = path.join(dir, '.lock');
  const handle = await acquire(lockPath, { operation: 'test' });
  assert.ok(fs.existsSync(lockPath));
  const meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.operation, 'test');
  assert.strictEqual(typeof meta.pid, 'number');
  release(handle);
  assert.ok(!fs.existsSync(lockPath));
  fs.rmSync(dir, { recursive: true });
});

test('isStale detects locks older than STALE_MS', () => {
  const meta = { pid: 1, host: 'x', created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(), operation: 'test' };
  assert.strictEqual(isStale(meta), true);
});

test('R3 P9: StaleLockError propagates with code STALE_LOCK (not swallowed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-stale-'));
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'metadata.json'), JSON.stringify({
    pid: 99999, host: 'gone', created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(), operation: 'crashed'
  }));
  await assert.rejects(
    () => acquire(lockPath, { operation: 'next' }),
    (e) => e instanceof StaleLockError && e.code === 'STALE_LOCK'
  );
  breakLock(lockPath);
  fs.rmSync(dir, { recursive: true });
});
