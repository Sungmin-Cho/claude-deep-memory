'use strict';
// E5 fix contract — Claude Code auto-loads the standard hooks/hooks.json in
// ADDITION to the manifest.hooks file ("The standard hooks/hooks.json is loaded
// automatically, so manifest.hooks should only reference additional hook
// files"). So the Codex discovery file also fires on Claude Code, where
// `${PLUGIN_ROOT}` is unset: the shell expanded it to '' and every event ran
// `node "/scripts/hooks/<x>.mjs"` → MODULE_NOT_FOUND, surfacing
// "Failed with non-blocking status code: node:internal/modules/cjs/loader:1478"
// on every SessionStart / UserPromptSubmit / PostToolUse / PreCompact.
//
// The fix mirrors the E4 bootstrap for hooks/hooks.json with one extra rule:
// on a Claude host (CLAUDE_PLUGIN_ROOT set) the Codex file must delegate —
// exit 0 without spawning capture — because hooks.claude.json already owns the
// six Claude events; running both would double-capture every event.

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
  PreCompact: 'pre-compact.mjs',
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

function runBootstrap(body, { env = {}, input = '', cwd = root } = {}) {
  const clean = { ...process.env };
  delete clean.CLAUDE_PLUGIN_ROOT;
  delete clean.PLUGIN_ROOT;
  return spawnSync(process.execPath, ['-e', body], {
    input, cwd, encoding: 'utf8', timeout: 15000, shell: false, windowsHide: true,
    env: { ...clean, ...env },
  });
}

function makeFixtureRoot(stubSource, script = 'session-start.mjs') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-codex-guard Ω '));
  const scripts = path.join(dir, 'scripts', 'hooks');
  fs.mkdirSync(scripts, { recursive: true });
  if (stubSource !== null) {
    fs.writeFileSync(path.join(scripts, script), stubSource);
  }
  return dir;
}

function markerStub(marker, exitCode = 7) {
  return [
    "import { writeFileSync } from 'node:fs';",
    "let data = '';",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('end', () => {",
    `  writeFileSync(${JSON.stringify(marker)}, data);`,
    `  process.exit(${exitCode});`,
    '});',
    '',
  ].join('\n');
}

// ── manifest shape ────────────────────────────────────────────────

test('E5: hooks.json keeps the four Codex events, one shell-safe bootstrap handler each', () => {
  const { hooks } = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), [...EVENTS].sort());
  for (const event of EVENTS) {
    assert.equal(hooks[event][0].matcher, '*', `${event}: matcher preserved`);
    const handler = onlyHandler(hooks[event]);
    assert.equal(handler.type, 'command', event);
    const body = bootstrapBody(handler.command);
    // No template expansion — Claude Code leaves ${PLUGIN_ROOT} to the shell,
    // which expands it to '' and crashes node on a rootless absolute path.
    assert.doesNotMatch(handler.command, /\$\{/, event);
    // Claude host guard, then Codex root resolution.
    assert.match(body, /process\.env\.CLAUDE_PLUGIN_ROOT/, event);
    assert.match(body, /process\.env\.PLUGIN_ROOT/, event);
    assert.match(body, /process\.exit\(0\)/, event);
    assert.doesNotMatch(body, /process\.exit\(2\)/, event);
    assert.ok(body.includes(`'scripts','hooks','${SCRIPTS[event]}'`),
      `${event}: bootstrap must join scripts/hooks/${SCRIPTS[event]}`);
    // The one command must be safe under bash, PowerShell, and cmd alike.
    for (const forbidden of ['$', '"', '`', '!', '%']) {
      assert.equal(body.includes(forbidden), false,
        `${event}: bootstrap must not contain shell-unsafe character ${forbidden}`);
    }
    // Windows keeps the identical cross-shell bootstrap.
    assert.equal(handler.commandWindows, handler.command,
      `${event}: commandWindows must reuse the shell-safe bootstrap`);
  }
});

// ── host routing ──────────────────────────────────────────────────

test('E5: on a Claude host the Codex file delegates — exits 0 and never spawns capture', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.json').hooks.SessionStart).command);
  const marker = path.join(os.tmpdir(), `dm-guard-marker-${process.pid}-${Date.now()}.json`);
  const fixture = makeFixtureRoot(markerStub(marker));
  try {
    const result = runBootstrap(body, {
      // Both roots set — the realistic Claude Code case is CLAUDE_PLUGIN_ROOT
      // set; PLUGIN_ROOT is added to prove the guard wins over capture.
      env: { CLAUDE_PLUGIN_ROOT: fixture, PLUGIN_ROOT: fixture },
      input: '{"session_id":"s"}',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false,
      'claude host must not double-capture: hooks.claude.json owns the event');
    assert.match(result.stderr, /claude host/,
      'the delegation skip must leave a stderr breadcrumb');
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('E5: on a Codex host the bootstrap spawns the script, forwards stdin, propagates exit', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.json').hooks.SessionStart).command);
  const marker = path.join(os.tmpdir(), `dm-guard-marker-${process.pid}-${Date.now() + 1}.json`);
  const fixture = makeFixtureRoot(markerStub(marker));
  try {
    const result = runBootstrap(body, {
      env: { PLUGIN_ROOT: fixture },
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

// ── fail-OPEN runtime behavior ────────────────────────────────────

test('E5: bootstrap fails OPEN (exit 0) with a breadcrumb when no plugin root is set', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.json').hooks.SessionStart).command);
  const result = runBootstrap(body, { input: '{"session_id":"s"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /plugin root env unset; capture skipped/);
});

test('E5: bootstrap fails OPEN (exit 0) with a breadcrumb when the capture script is missing', () => {
  const body = bootstrapBody(onlyHandler(readJson('hooks/hooks.json').hooks.SessionStart).command);
  const fixture = makeFixtureRoot(null);
  try {
    const result = runBootstrap(body, { env: { PLUGIN_ROOT: fixture }, input: '{"session_id":"s"}' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /missing .*session-start\.mjs; capture skipped/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ── regression guard: the pre-fix form crashed on Claude Code ─────

test('E5 regression: the old shell-expanded form crashes exactly like the reported error', () => {
  // On Claude Code, `node "${PLUGIN_ROOT}/scripts/hooks/x.mjs"` became
  // `node /scripts/hooks/x.mjs` → MODULE_NOT_FOUND (cjs/loader), nonzero exit —
  // the "Failed with non-blocking status code" the user sees per event.
  const oldForm = spawnSync(process.execPath, ['/scripts/hooks/session-start.mjs'], {
    encoding: 'utf8', shell: false, windowsHide: true,
  });
  assert.notEqual(oldForm.status, 0);
  assert.match(oldForm.stderr, /Cannot find module/);
});
