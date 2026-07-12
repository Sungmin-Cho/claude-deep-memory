'use strict';
// Hook resilience regression: a Tier-1 hook must NEVER break the host session.
// Pre-fix, with capture ON, malformed stdin crashed at JSON.parse (exit 1) and a
// stale .lock made acquire() throw StaleLockError (exit 1) — so every tool-use
// hook failed until the user ran /deep-memory-audit --unlock. Both must now
// exit 0, and the stale-lock case must skip the capture with a warning (the
// lock is NOT auto-broken — that stays a deliberate audit op).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeValidProjectProfile } = require('../helpers/project-profile-fixtures');

const ROOT = path.resolve(__dirname, '../..');

function hookScripts(manifestPath) {
  const hooks = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).hooks;
  return Object.fromEntries(Object.entries(hooks).map(([event, entries]) => {
    const handlers = entries.flatMap((entry) => entry.hooks || []);
    assert.strictEqual(handlers.length, 1, `${event}: expected exactly one handler`);
    const match = handlers[0].command.match(/scripts[\\/]hooks[\\/]([^"']+\.mjs)/);
    assert.ok(match, `${event}: command must name a hook script`);
    return [event, match[1]];
  }));
}

const CLAUDE_HOOKS = hookScripts(path.join(ROOT, '.claude-plugin', 'plugin.json'));
const CODEX_HOOKS = hookScripts(path.join(ROOT, 'hooks', 'hooks.json'));
const HOOKS = [...new Set([...Object.values(CLAUDE_HOOKS), ...Object.values(CODEX_HOOKS)])];

function mkTmpRoot(captureEnabled = true) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dm hook resilience Ω '));
  fs.writeFileSync(path.join(r, 'config.yaml'), `capture:\r\n  enabled: ${captureEnabled}\r\n`);
  if (captureEnabled) writeValidProjectProfile(r);
  return r;
}

function runHook(script, root, input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', script)], {
    cwd: root,
    input: input.endsWith('\r\n') ? input : `${input}\r\n`,
    env: { ...process.env, DEEP_MEMORY_ROOT: root, PROJECT_CWD: root },
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
    windowsHide: true,
  });
}

function monthFile(root) {
  return path.join(root, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
}

for (const script of HOOKS) {
  test(`${script}: malformed stdin (capture ON) exits 0, no crash`, () => {
    const root = mkTmpRoot(true);
    const r = runHook(script, root, 'this is not valid json {{{');
    assert.strictEqual(r.status, 0, `${script} must exit 0 on malformed stdin; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${script}: malformed input must not pollute stdout`);
    // No event line should have been appended from unparseable input.
    if (fs.existsSync(monthFile(root))) {
      const lines = fs.readFileSync(monthFile(root), 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 0, `${script}: no event should be written from bad input`);
    }
  });
}

test('post-tool-use: stale .lock (capture ON) → exit 0, capture skipped with warning, lock NOT broken', () => {
  const root = mkTmpRoot(true);
  const lockDir = path.join(root, '.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'metadata.json'),
    JSON.stringify({ pid: 999999, host: 'ghost', created_at: '2000-01-01T00:00:00.000Z', operation: 'harvest' })
  );

  const r = runHook('post-tool-use.mjs', root, JSON.stringify({
    tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, tool_output: 'ok', session_id: 's1',
  }));

  assert.strictEqual(r.status, 0, `must exit 0 on stale lock; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'lock contention must not pollute stdout');
  assert.match(r.stderr, /stale lock/i, 'should log a stale-lock warning');
  // Event skipped — no line appended while the stale lock is held.
  if (fs.existsSync(monthFile(root))) {
    const lines = fs.readFileSync(monthFile(root), 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 0, 'capture must be skipped, not appended, under a stale lock');
  }
  // The stale lock is left in place for /deep-memory-audit --unlock (not auto-broken).
  assert.ok(fs.existsSync(path.join(lockDir, 'metadata.json')), 'stale lock must NOT be auto-broken');
});

test('post-tool-use: malformed stdin with capture OFF still exits 0 (gate short-circuits before parse)', () => {
  const root = mkTmpRoot(false);
  const r = runHook('post-tool-use.mjs', root, 'garbage{{{');
  assert.strictEqual(r.status, 0, `capture-OFF gate must exit 0 before reading stdin; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'capture-OFF path should not pollute stdout');
  assert.strictEqual(r.stderr.trim(), '', 'capture-OFF path should be completely silent');
});
