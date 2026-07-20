'use strict';
// E4 fix contract — Claude capture hooks load from a dedicated file manifest
// (hooks/hooks.claude.json) whose commands are fail-OPEN env-bootstraps.
//
// Root cause (measured): Claude Code does NOT expand `${CLAUDE_PLUGIN_ROOT}` in
// an INLINE manifest hook command → the old inline form ran
// `node "/scripts/hooks/<x>.mjs"` → MODULE_NOT_FOUND, silently disabling every
// capture hook. The fix moves the six events into hooks/hooks.claude.json and
// replaces the template-literal command with a `node -e` bootstrap that resolves
// the plugin root from process.env at runtime and, being best-effort capture,
// fails OPEN (exit 0) on any resolution/spawn problem so the session is never
// disrupted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const SCRIPTS = Object.freeze({
  SessionStart: 'session-start.mjs',
  UserPromptSubmit: 'user-prompt-submit.mjs',
  PostToolUse: 'post-tool-use.mjs',
  PostToolUseFailure: 'post-tool-failure.mjs',
  PreCompact: 'pre-compact.mjs',
  SessionEnd: 'session-end.mjs',
});
const EVENTS = Object.keys(SCRIPTS);

function onlyHandler(entries) {
  const handlers = entries.flatMap((entry) => entry.hooks || []);
  assert.equal(handlers.length, 1);
  return handlers[0];
}

function bootstrapBody(command) {
  assert.match(command, /^node -e "/);
  assert.equal(command.endsWith('"'), true);
  return command.slice('node -e "'.length, -1);
}

// Run a bootstrap body directly through `node -e`, mirroring how the host
// invokes the hook command's `node -e "<body>"` form.
function runBootstrap(body, { env = {}, input = '', cwd = root } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDE_PLUGIN_ROOT;
  delete clean.PLUGIN_ROOT;
  return spawnSync(process.execPath, ['-e', body], {
    input, cwd, encoding: 'utf8', timeout: 15000, shell: false, windowsHide: true,
    env: { ...clean, ...env },
  });
}

function makeFixtureRoot(stubSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-claude-bootstrap Ω '));
  const scripts = path.join(dir, 'scripts', 'hooks');
  fs.mkdirSync(scripts, { recursive: true });
  if (stubSource !== null) {
    fs.writeFileSync(path.join(scripts, 'session-start.mjs'), stubSource);
  }
  return dir;
}

// ── manifest shape ────────────────────────────────────────────────

test('E4: Claude manifest hooks field points to the dedicated hook file', () => {
  assert.equal(readJson('.claude-plugin/plugin.json').hooks, './hooks/hooks.claude.json');
});

test('E4: hooks.claude.json carries all six events, one command handler each, matcher preserved', () => {
  const { hooks } = readJson('hooks/hooks.claude.json');
  assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
  for (const event of EVENTS) {
    assert.ok(Array.isArray(hooks[event]) && hooks[event].length > 0, event);
    assert.equal(hooks[event][0].matcher, '*', `${event}: matcher preserved`);
    const handler = onlyHandler(hooks[event]);
    assert.equal(handler.type, 'command', event);
    assert.equal(Object.hasOwn(handler, 'commandWindows'), false,
      `${event}: env-bootstrap is cross-platform, no commandWindows`);
  }
});

test('E4: every command is a shell-safe env-bootstrap referencing its event script', () => {
  const { hooks } = readJson('hooks/hooks.claude.json');
  for (const event of EVENTS) {
    const command = onlyHandler(hooks[event]).command;
    const body = bootstrapBody(command);
    // No template expansion — the whole point of the fix.
    assert.doesNotMatch(command, /\$\{/, event);
    // Resolves the plugin root at runtime, Codex fallback included.
    assert.match(body, /process\.env\.CLAUDE_PLUGIN_ROOT/, event);
    assert.match(body, /process\.env\.PLUGIN_ROOT/, event);
    // Fail-OPEN: no root and no script both exit 0 (never exit 2 / never throw).
    assert.match(body, /process\.exit\(0\)/, event);
    assert.doesNotMatch(body, /process\.exit\(2\)/, event);
    // Targets exactly this event's capture script via a path.join, not a literal.
    assert.ok(body.includes(`'scripts','hooks','${SCRIPTS[event]}'`),
      `${event}: bootstrap must join scripts/hooks/${SCRIPTS[event]}`);
    // Shell-unsafe characters must never appear in the bootstrap body.
    for (const forbidden of ['$', '"', '`', '!', '%']) {
      assert.equal(body.includes(forbidden), false,
        `${event}: bootstrap must not contain shell-unsafe character ${forbidden}`);
    }
  }
});

// ── fail-OPEN runtime behavior ────────────────────────────────────

test('E4: bootstrap fails OPEN (exit 0) when no plugin root is set', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.claude.json').hooks.SessionStart).command);
  const result = runBootstrap(body, { input: '{"session_id":"s"}' });
  assert.equal(result.status, 0, result.stderr);
});

test('E4: bootstrap fails OPEN (exit 0) when the capture script is missing', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.claude.json').hooks.SessionStart).command);
  const fixture = makeFixtureRoot(null); // scripts/hooks exists but no session-start.mjs
  const result = runBootstrap(body, { env: { CLAUDE_PLUGIN_ROOT: fixture }, input: '{"session_id":"s"}' });
  assert.equal(result.status, 0, result.stderr);
});

test('E4: bootstrap spawns the resolved script, forwards stdin, and propagates its exit code', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.claude.json').hooks.SessionStart).command);
  const marker = path.join(os.tmpdir(), `dm-bootstrap-marker-${process.pid}-${Date.now()}.json`);
  // The real capture scripts are .mjs (ES modules); the stub must be ESM too —
  // this proves the bootstrap spawns the resolved script as a module.
  const stub = [
    "import { writeFileSync } from 'node:fs';",
    "let data = '';",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('end', () => {",
    `  writeFileSync(${JSON.stringify(marker)}, data);`,
    '  process.exit(7);',
    '});',
    '',
  ].join('\n');
  const fixture = makeFixtureRoot(stub);
  try {
    const result = runBootstrap(body, {
      env: { CLAUDE_PLUGIN_ROOT: fixture },
      input: '{"session_id":"passthrough"}',
    });
    assert.equal(result.status, 7, `child exit code must propagate; stderr=${result.stderr}`);
    assert.equal(fs.existsSync(marker), true, 'resolved capture script must actually run');
    assert.match(fs.readFileSync(marker, 'utf8'), /passthrough/, 'event stdin must reach the child');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ── regression guard: the pre-fix inline form crashed on an unresolved root ──

test('E4 regression: unresolved root crashes the OLD inline form but the bootstrap fails open', () => {
  // Pre-fix, an inline command `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/x.mjs"`
  // with an unexpanded/empty root ran `node "/scripts/hooks/x.mjs"` → nonzero.
  const oldForm = spawnSync(process.execPath, ['/scripts/hooks/session-start.mjs'], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.notEqual(oldForm.status, 0, 'the pre-fix inline form must fail on an unresolved root');

  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.claude.json').hooks.SessionStart).command);
  const fixed = runBootstrap(body, { input: '{"session_id":"s"}' });
  assert.equal(fixed.status, 0, 'the bootstrap must fail open on the same unresolved root');
});
