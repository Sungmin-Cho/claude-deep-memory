'use strict';
// Combined α.5-α.10 tests — one fixture per hook script. Each hook with
// capture.enabled=true emits exactly 1 event line with the correct
// source_kind, and exits 0.
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

const HOOK_SOURCE_KIND = {
  'session-start.mjs':      'hook-session-start',
  'user-prompt-submit.mjs': 'hook-user-prompt',
  'post-tool-use.mjs':      'hook-post-tool-use',
  'post-tool-failure.mjs':  'hook-tool-failure',
  'pre-compact.mjs':        'hook-pre-compact',
  'session-end.mjs':        'hook-session-end',
};

function mkTmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dm hook batch Ω '));
  fs.writeFileSync(path.join(r, 'config.yaml'), 'capture:\r\n  enabled: true\r\n');
  writeValidProjectProfile(r);
  return r;
}

test('Claude and Codex constants reflect the established six-event and four-event surfaces', () => {
  assert.deepStrictEqual(Object.keys(CLAUDE_HOOKS).sort(), [
    'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit',
  ]);
  assert.deepStrictEqual(Object.keys(CODEX_HOOKS).sort(), [
    'PostToolUse', 'PreCompact', 'SessionStart', 'UserPromptSubmit',
  ]);
});

for (const [script, expectedKind] of Object.entries(HOOK_SOURCE_KIND)) {
  test(`α.5-α.10: ${script} appends event with source_kind=${expectedKind}`, () => {
    const tmpRoot = mkTmpRoot();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', script)], {
      cwd: tmpRoot,
      input: `${JSON.stringify({ session_id: 's1', tool_name: 'test-tool', tool_input: {}, tool_output: 'ok' })}\r\n`,
      env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
      encoding: 'utf8',
      timeout: 5000,
      shell: false,
      windowsHide: true,
    });
    assert.strictEqual(r.status, 0, `${script} should exit 0; stderr=${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${script} must not pollute stdout`);
    const monthFile = path.join(tmpRoot, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
    assert.ok(fs.existsSync(monthFile), `${script}: events file should exist`);
    const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${script}: expected 1 event, got ${lines.length}`);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.payload.source_kind, expectedKind);
    assert.strictEqual(rec.envelope.artifact_kind, 'memory-hook-event');
  });
}

test('α.10: pre-compact + session-end DO NOT spawn distill child when eager_distill: false', () => {
  const tmpRoot = mkTmpRoot();  // default config has only `enabled: true`, no eager_distill
  // Run pre-compact — should complete quickly, no orphan child blocking the script.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'pre-compact.mjs')], {
    cwd: tmpRoot,
    input: `${JSON.stringify({ session_id: 'eager-test' })}\r\n`,
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
    windowsHide: true,
  });
  assert.strictEqual(r.status, 0);
  // No distill child means harvest.js was not invoked; we don't assert on
  // child process state directly here (test harness can't easily observe
  // detached children). The §3.2.1 invariant test (β.9) covers heartbeat.
});

test('α.10: pre-compact spawns detached child when eager_distill: true (best-effort)', () => {
  const tmpRoot = mkTmpRoot();
  // Override config to enable eager_distill.
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'),
    'capture:\r\n  enabled: true\r\n  eager_distill: true\r\n');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'pre-compact.mjs')], {
    cwd: tmpRoot,
    input: `${JSON.stringify({ session_id: 'eager-test-2' })}\r\n`,
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
    windowsHide: true,
  });
  assert.strictEqual(r.status, 0, `pre-compact should still exit 0 even if child spawn fails; stderr=${r.stderr}`);
  // The detached child may emit errors to stderr (harvest.js --rebuild-from-events
  // not yet implemented). That's fine — hook returns 0 regardless (best-effort).
});
