'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectStaleLocks } = require('../scripts/audit');

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-stalelock-')); }

function plantLock(memoryRoot, { ageMs, operation = 'harvest' } = {}) {
  const lockPath = path.join(memoryRoot, '.lock');
  fs.mkdirSync(lockPath, { recursive: true });
  const createdAt = new Date(Date.now() - (ageMs || 0)).toISOString();
  fs.writeFileSync(
    path.join(lockPath, 'metadata.json'),
    JSON.stringify({
      pid: 12345,
      host: 'test-host',
      created_at: createdAt,
      operation,
    })
  );
  return lockPath;
}

test('Task 5.3: detectStaleLocks reports lock older than STALE_MS as stale=true', () => {
  const tmp = mkRoot();
  try {
    plantLock(tmp, { ageMs: 6 * 60 * 1000 }); // 6 min — STALE_MS is 5 min
    const out = detectStaleLocks(tmp);
    assert.strictEqual(out.locks.length, 1);
    assert.strictEqual(out.locks[0].stale, true);
    assert.strictEqual(out.locks[0].meta.operation, 'harvest');
    assert.deepStrictEqual(out.broken, [], 'no break without {unlock: true}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.3: detectStaleLocks reports recent lock as stale=false', () => {
  const tmp = mkRoot();
  try {
    plantLock(tmp, { ageMs: 30 * 1000 }); // 30 sec — fresh
    const out = detectStaleLocks(tmp);
    assert.strictEqual(out.locks[0].stale, false);
    assert.ok(out.locks[0].age_ms >= 30 * 1000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.3: --unlock breaks stale lock and reports it', () => {
  const tmp = mkRoot();
  try {
    const lp = plantLock(tmp, { ageMs: 6 * 60 * 1000 });
    assert.ok(fs.existsSync(lp));
    const out = detectStaleLocks(tmp, { unlock: true });
    assert.strictEqual(out.locks[0].stale, true);
    assert.deepStrictEqual(out.broken, [lp]);
    assert.ok(!fs.existsSync(lp), 'lock directory removed by breakLock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.3: --unlock does NOT break recent (non-stale) lock', () => {
  const tmp = mkRoot();
  try {
    const lp = plantLock(tmp, { ageMs: 30 * 1000 });
    const out = detectStaleLocks(tmp, { unlock: true });
    assert.strictEqual(out.locks[0].stale, false);
    assert.deepStrictEqual(out.broken, []);
    assert.ok(fs.existsSync(lp), 'recent lock survives --unlock');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.3: no lock dir → empty report (no error)', () => {
  const tmp = mkRoot();
  try {
    const out = detectStaleLocks(tmp);
    assert.deepStrictEqual(out, { locks: [], broken: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.3: malformed metadata.json surfaces lock as stale (defensive)', () => {
  const tmp = mkRoot();
  try {
    const lockPath = path.join(tmp, '.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'metadata.json'), '{ NOT JSON');
    const out = detectStaleLocks(tmp);
    assert.strictEqual(out.locks[0].stale, true,
      'unreadable metadata → treat as stale so audit + --unlock can recover');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
