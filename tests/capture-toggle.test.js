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

// ---------------------------------------------------------------------------
// Round-1 deep-review regression tests (F1 silent-toggle, F2 audit, F3 no-op).
// The hook reader contract (scripts/hooks/common.mjs) is /capture:\s*\n\s*enabled:\s*true/
// — `enabled:` must be the FIRST child of `capture:`. The writer must guarantee it.
// ---------------------------------------------------------------------------

function captureBlockCount(text) {
  return (text.match(/^[ \t]*capture:/gm) || []).length;
}

test('F1/C1: capture block lacking enabled + a later sources enabled — enable edits the block, not the later line', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(
      configPath(root),
      'version: "0.1.0"\ncapture:\n  eager_distill: false\nsources:\n  - kind: x\n    enabled: true\n'
    );
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.strictEqual(r.changed, true);
    const out = readConfig(root);
    // reader contract satisfied
    assert.match(out, /capture:\s*\n\s*enabled:\s*true/, 'hook reader must see capture enabled');
    // the unrelated sources entry is untouched
    assert.match(out, /- kind: x\n {4}enabled: true/, 'sources.enabled must remain');
    // exactly one capture block
    assert.strictEqual(captureBlockCount(out), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F1/C2: capture block lacking enabled and no later enabled — enable inserts enabled (reader sees true)', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), 'version: "0.1.0"\ncapture:\n  eager_distill: false\n');
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.strictEqual(r.changed, true);
    assert.match(readConfig(root), /capture:\s*\n\s*enabled:\s*true/);
    assert.strictEqual(captureBlockCount(readConfig(root)), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F1/C3: CRLF config — enable produces a reader-matchable single capture block', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), 'version: "0.1.0"\r\ncapture:\r\n  enabled: false\r\n');
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.strictEqual(r.changed, true);
    const out = readConfig(root);
    assert.match(out, /capture:\s*\n\s*enabled:\s*true/, 'reader must match across CRLF');
    assert.strictEqual(captureBlockCount(out), 1, 'no duplicate capture block on CRLF');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F1/C4: capture marker with a trailing comment — enable does not append a duplicate block', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), 'version: "0.1.0"\ncapture:  # auto-capture\n  enabled: false\n');
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.strictEqual(r.changed, true);
    const out = readConfig(root);
    assert.match(out, /capture:\s*\n\s*enabled:\s*true/);
    assert.strictEqual(captureBlockCount(out), 1, 'trailing comment must not spawn a second capture block');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F1/M1: eager_distill before enabled — enable canonicalizes enabled to the first child', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), 'version: "0.1.0"\ncapture:\n  eager_distill: false\n  enabled: false\n');
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'cli-flag' });
    assert.strictEqual(r.changed, true);
    const out = readConfig(root);
    assert.match(out, /capture:\s*\n\s*enabled:\s*true/, 'enabled must become the first child');
    // eager_distill preserved (not lost during reconstruction)
    assert.match(out, /eager_distill:\s*false/);
    assert.strictEqual(captureBlockCount(out), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F3: legacy config (no capture block) + disable is a true no-op (no write, no audit)', () => {
  const root = mkRoot();
  try {
    const original = 'version: "0.1.0"\nprivacy:\n  default_scope: local\n';
    fs.writeFileSync(configPath(root), original);
    const r = setCaptureEnabled(root, false, { by: 'cli-flag', method: 'cli-flag' });
    assert.deepStrictEqual(r, { from: false, to: false, changed: false });
    assert.strictEqual(readConfig(root), original, 'no-op disable must not rewrite the file');
    assert.strictEqual(
      readAudit(root).filter((e) => e.kind === 'capture-toggle').length,
      0,
      'no-op disable must not emit a transition audit'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F2: audit-log write failure is non-fatal — config still toggled, warning surfaced', () => {
  const root = mkRoot();
  try {
    fs.writeFileSync(configPath(root), defaultConfigYaml());
    // Force writeEntry to throw via a schema-invalid method (not in the enum).
    const r = setCaptureEnabled(root, true, { by: 'cli-flag', method: 'not-a-valid-method' });
    assert.strictEqual(r.changed, true, 'transition must still complete');
    assert.match(readConfig(root), /capture:\s*\n\s*enabled:\s*true/, 'config must be written despite audit failure');
    assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 1, 'an audit-failure warning must be surfaced');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F5: CLI rejects an unknown --flag with exit 1', () => {
  const root = mkRoot();
  try {
    const r = spawnSync('node', ['scripts/init.js', root, '--enable-captur'], {
      cwd: REPO, encoding: 'utf8', timeout: 10000
    });
    assert.strictEqual(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
    assert.match(r.stderr, /unknown|invalid|unrecognized/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F5: CLI rejects more than one positional memory_root with exit 1', () => {
  const root = mkRoot();
  try {
    const r = spawnSync('node', ['scripts/init.js', root, '/tmp/second-root'], {
      cwd: REPO, encoding: 'utf8', timeout: 10000
    });
    assert.strictEqual(r.status, 1, `expected exit 1; stderr=${r.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
