const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  acquire, release, inspectLock, inspectEmptyLock, isStale, breakLock, breakEmptyLock,
  StaleLockError, STALE_MS,
} = require('../scripts/lib/lock');

test('acquire creates lock dir + metadata, release removes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-'));
  const lockPath = path.join(dir, '.lock');
  const handle = await acquire(lockPath, { operation: 'test' });
  assert.ok(fs.existsSync(lockPath));
  const meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.operation, 'test');
  assert.strictEqual(typeof meta.pid, 'number');
  assert.match(meta.owner_token, /^[0-9a-f-]{36}$/i);
  assert.strictEqual(handle.ownerToken, meta.owner_token);
  assert.strictEqual(release(handle), true);
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
  const claim = inspectLock(lockPath);
  assert.ok(claim);
  assert.strictEqual(breakLock(lockPath, claim), true);
  fs.rmSync(dir, { recursive: true });
});

test('release verifies exact ownership and leaves a replacement lock byte-identical', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, '.lock');
  const displaced = path.join(dir, '.lock.displaced');
  const handle = await acquire(lockPath, { operation: 'old-owner' });
  fs.renameSync(lockPath, displaced);
  fs.mkdirSync(lockPath);
  const replacement = Buffer.from(JSON.stringify({
    pid: process.pid, host: 'replacement', created_at: new Date().toISOString(),
    operation: 'replacement', owner_token: '11111111-1111-4111-8111-111111111111',
  }, null, 2));
  fs.writeFileSync(path.join(lockPath, 'metadata.json'), replacement);

  assert.strictEqual(release(handle), false);
  assert.deepEqual(fs.readFileSync(path.join(lockPath, 'metadata.json')), replacement);
  assert.ok(fs.existsSync(lockPath));
});

test('stale break is conditional on the exact observation and cannot delete a new owner', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-stale-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, '.lock');
  const displaced = path.join(dir, '.lock.displaced');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'metadata.json'), JSON.stringify({
    pid: 1, host: 'stale', created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(),
    operation: 'stale', owner_token: '22222222-2222-4222-8222-222222222222',
  }, null, 2));
  const staleClaim = inspectLock(lockPath);
  assert.ok(staleClaim && isStale(staleClaim.meta));

  fs.renameSync(lockPath, displaced);
  fs.mkdirSync(lockPath);
  const replacement = Buffer.from(JSON.stringify({
    pid: process.pid, host: 'fresh', created_at: new Date().toISOString(),
    operation: 'fresh', owner_token: '33333333-3333-4333-8333-333333333333',
  }, null, 2));
  fs.writeFileSync(path.join(lockPath, 'metadata.json'), replacement);

  assert.strictEqual(breakLock(lockPath, staleClaim), false);
  assert.deepEqual(fs.readFileSync(path.join(lockPath, 'metadata.json')), replacement);
  assert.ok(fs.existsSync(lockPath));
});

test('metadata-free stale break is identity-bound and cannot delete a replacement owner', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-empty-lock-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, '.lock');
  const displaced = path.join(dir, '.lock.displaced');
  fs.mkdirSync(lockPath);
  const old = new Date(Date.now() - STALE_MS - 1000);
  fs.utimesSync(lockPath, old, old);
  const staleEmptyClaim = inspectEmptyLock(lockPath);
  assert.ok(staleEmptyClaim);

  fs.renameSync(lockPath, displaced);
  fs.mkdirSync(lockPath);
  const replacement = Buffer.from(JSON.stringify({
    pid: process.pid, host: 'fresh', created_at: new Date().toISOString(),
    operation: 'fresh', owner_token: '44444444-4444-4444-8444-444444444444',
  }, null, 2));
  fs.writeFileSync(path.join(lockPath, 'metadata.json'), replacement);

  assert.strictEqual(breakEmptyLock(lockPath, staleEmptyClaim), false);
  assert.deepEqual(fs.readFileSync(path.join(lockPath, 'metadata.json')), replacement);
  assert.ok(fs.existsSync(lockPath));
});

test('metadata-free break helper refuses a fresh exact empty lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-empty-lock-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);
  const freshClaim = inspectEmptyLock(lockPath);
  assert.ok(freshClaim);
  assert.strictEqual(breakEmptyLock(lockPath, freshClaim), false);
  assert.ok(fs.existsSync(lockPath));
});
