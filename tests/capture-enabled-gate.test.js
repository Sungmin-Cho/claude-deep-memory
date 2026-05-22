'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-capture-gate-'));
}

function writeConfig(root, captureEnabled) {
  const cfg = `capture:\n  enabled: ${captureEnabled ? 'true' : 'false'}\n`;
  fs.writeFileSync(path.join(root, 'config.yaml'), cfg);
}

test('R4-D: hook with capture.enabled=false leaves events.jsonl unchanged', () => {
  const tmpRoot = mkTmpRoot();
  writeConfig(tmpRoot, false);
  const eventsDir = path.join(tmpRoot, 'events');
  // baseline: events/ may not exist; expect still not to exist after hook runs
  const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, session_id: 's1' }),
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.strictEqual(r.status, 0, `hook should exit 0 but got status=${r.status}, stderr=${r.stderr}`);
  // Events file should NOT exist (early exit before any write)
  const monthFile = path.join(eventsDir, new Date().toISOString().slice(0, 7) + '.jsonl');
  const exists = fs.existsSync(monthFile);
  if (exists) {
    const sz = fs.statSync(monthFile).size;
    assert.strictEqual(sz, 0, `events file unexpectedly non-empty: ${sz} bytes`);
  }
  // ok if absent
});

test('R4-D: capture.enabled=true → append exactly one event', () => {
  const tmpRoot = mkTmpRoot();
  writeConfig(tmpRoot, true);
  const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b\nc\nd' },
      tool_output: 'edited',
      session_id: 's1'
    }),
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.strictEqual(r.status, 0, `hook should exit 0; stderr=${r.stderr}`);
  const monthFile = path.join(tmpRoot, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
  assert.ok(fs.existsSync(monthFile), 'events file should exist after enabled hook');
  const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `expected 1 event line, got ${lines.length}`);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.envelope.artifact_kind, 'memory-hook-event');
  assert.strictEqual(rec.payload.source_kind, 'hook-post-tool-use');
});

test('R4-D: missing config.yaml → safe default (capture disabled)', () => {
  const tmpRoot = mkTmpRoot();
  // No config.yaml written — default should be disabled per common.mjs.
  const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: {}, session_id: 's1' }),
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.strictEqual(r.status, 0);
  // events/ should be empty or absent
  const eventsDir = path.join(tmpRoot, 'events');
  if (fs.existsSync(eventsDir)) {
    const files = fs.readdirSync(eventsDir);
    assert.strictEqual(files.length, 0, `no events expected, got: ${files}`);
  }
});
