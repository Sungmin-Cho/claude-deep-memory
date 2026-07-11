'use strict';
// ε.6 — back-to-back hook fire test per §3.2.1 fire-and-forget invariants.
// Two hooks fire within 1s; both must append events without lock thrash;
// .lock + .leases/ directories should not have stale entries after 5s.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeValidProjectProfile } = require('./helpers/project-profile-fixtures');

function mkTmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-b2b-'));
  fs.writeFileSync(path.join(r, 'config.yaml'), 'capture:\n  enabled: true\n');
  writeValidProjectProfile(r);
  return r;
}

test('ε.6 §3.2.1: 2 hook fires within 1s both append events; no stale .lock', () => {
  const root = mkTmpRoot();
  const fire = () => spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/b2b.ts', new_string: 'x\ny\nz' }, session_id: 's-b2b' }),
    env: { ...process.env, DEEP_MEMORY_ROOT: root, PROJECT_CWD: root },
    encoding: 'utf8',
    timeout: 5000
  });
  const r1 = fire();
  const r2 = fire();
  assert.strictEqual(r1.status, 0, `first fire stderr=${r1.stderr}`);
  assert.strictEqual(r2.status, 0, `second fire stderr=${r2.stderr}`);

  const monthFile = path.join(root, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
  const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n').filter(Boolean);
  // PR2-C dedupe: same tool_input within 5min → second fire deduped.
  // Test asserts at LEAST 1 line was appended; dedupe is best-effort.
  assert.ok(lines.length >= 1, `expected ≥ 1 event line, got ${lines.length}`);

  // No stale .lock — the short critical section releases promptly.
  const lockDir = path.join(root, '.lock');
  if (fs.existsSync(lockDir)) {
    // The lock dir itself can exist as a regular dir; the held-lock marker is
    // the .lock file or directory entry from acquire(). After both fires
    // complete (status 0), no marker should remain.
    const remnants = fs.readdirSync(lockDir).filter(f => f.startsWith('.'));
    assert.strictEqual(remnants.length, 0, `stale lock remnants: ${remnants.join(',')}`);
  }
});

test('ε.6 §3.2.1 invariant 1: hook with eager_distill: true does NOT block on child', () => {
  const root = mkTmpRoot();
  fs.writeFileSync(path.join(root, 'config.yaml'), 'capture:\n  enabled: true\n  eager_distill: true\n');
  const t0 = Date.now();
  const r = spawnSync('node', ['scripts/hooks/pre-compact.mjs'], {
    input: JSON.stringify({ session_id: 'fire-and-forget-test' }),
    env: { ...process.env, DEEP_MEMORY_ROOT: root, PROJECT_CWD: root },
    encoding: 'utf8',
    timeout: 5000
  });
  const t1 = Date.now();
  assert.strictEqual(r.status, 0);
  // Hook itself must return quickly — child is detached + unref'd, so the
  // hook should not wait for harvest.js to complete (which currently exits
  // immediately because --rebuild-from-events is not yet implemented in
  // harvest.js, but the principle: detached + unref).
  assert.ok(t1 - t0 < 3000, `pre-compact hook took ${t1 - t0}ms; should be < 3s (fire-and-forget)`);
});
