'use strict';
// Tests for the --enable-capture / --disable-capture CLI toggle (spec
// 2026-05-25-capture-toggle-design.md). Covers the setCaptureEnabled module,
// the default-config capture block, init.js wiring, CLI mutual-exclusion, and
// the hook-contract regression (writer output must be readable by common.mjs).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { setCaptureEnabled } = require('../scripts/lib/capture-toggle');
const { defaultConfigYaml } = require('../scripts/lib/default-config');
const { run } = require('../scripts/init');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-captog-'));
}
function configPath(root) {
  return path.join(root, 'config.yaml');
}
function readConfig(root) {
  return fs.readFileSync(configPath(root), 'utf8');
}
function readAudit(root) {
  const ym = new Date().toISOString().slice(0, 7);
  const p = path.join(root, 'audit-log', `${ym}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('default-config: defaultConfigYaml contains capture.enabled false + eager_distill false', () => {
  const yaml = defaultConfigYaml();
  assert.match(yaml, /capture:\s*\n\s*enabled:\s*false/, 'capture.enabled:false missing');
  assert.match(yaml, /eager_distill:\s*false/, 'eager_distill:false missing');
});

test('setCaptureEnabled: enabling a fresh config sets enabled:true and reports the transition', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.deepStrictEqual(r, { from: false, to: true, changed: true });
    assert.match(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setCaptureEnabled: enabling writes exactly one capture-toggle audit entry', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    const entries = readAudit(root).filter((e) => e.kind === 'capture-toggle');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].by, 'cli-flag');
    assert.deepStrictEqual(entries[0].payload, { from: false, to: true, method: 'cli-flag' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setCaptureEnabled: re-enabling an already-enabled config is idempotent (no change, no audit)', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    const before = readConfig(root);
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.deepStrictEqual(r, { from: true, to: true, changed: false });
    assert.strictEqual(readConfig(root), before, 'config must be untouched on no-op');
    const entries = readAudit(root).filter((e) => e.kind === 'capture-toggle');
    assert.strictEqual(entries.length, 1, 'no-op must not append a second audit entry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setCaptureEnabled: disabling reports from:true to:false', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    const r = setCaptureEnabled(root, false, { by: 'cli-flag', method: 'cli-flag' });
    assert.deepStrictEqual(r, { from: true, to: false, changed: true });
    assert.doesNotMatch(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
    const last = readAudit(root).filter((e) => e.kind === 'capture-toggle').at(-1);
    assert.deepStrictEqual(last.payload, { from: true, to: false, method: 'cli-flag' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setCaptureEnabled: appends a capture block when an existing config lacks one', () => {
  const root = mkRoot();
  try {
    // legacy config (pre-0.3.2) with no capture block
    fs.writeFileSync(configPath(root), 'version: "0.1.0"\nprivacy:\n  default_scope: local\n');
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.deepStrictEqual(r, { from: false, to: true, changed: true });
    assert.match(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('init run({capture:true}) enables capture and returns the transition', async () => {
  const root = mkRoot();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const r = await run({ memoryRoot: root, capture: true });
    assert.deepStrictEqual(r.capture, { from: false, to: true, changed: true });
    assert.match(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('init run() without a capture arg leaves capture disabled and omits the capture result', async () => {
  const root = mkRoot();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const r = await run({ memoryRoot: root });
    assert.strictEqual(r.capture, undefined);
    assert.doesNotMatch(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('CLI: --enable-capture and --disable-capture together exits 1', () => {
  const root = mkRoot();
  try {
    const r = spawnSync('node', ['scripts/init.js', root, '--enable-capture', '--disable-capture'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
    assert.match(r.stderr, /mutually exclusive|both/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hook-contract: after setCaptureEnabled(true) the post-tool-use hook captures an event', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
      cwd: REPO,
      input: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b\nc' },
        tool_output: 'edited',
        session_id: 's-captog'
      }),
      env: { ...process.env, DEEP_MEMORY_ROOT: root, PROJECT_CWD: root },
      encoding: 'utf8',
      timeout: 5000
    });
    assert.strictEqual(r.status, 0, `hook exit !=0; stderr=${r.stderr}`);
    const monthFile = path.join(root, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
    assert.ok(fs.existsSync(monthFile), 'writer output not recognized as enabled by the hook reader');
    const lines = fs.readFileSync(monthFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
