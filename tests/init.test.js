'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run, resolveMemoryRoot, projectId } = require('../scripts/init');

test('init creates memory_root subdirectories + config.yaml + project-profile', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-init-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const r = await run({ memoryRoot: tmp });
    for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
      assert.ok(fs.existsSync(path.join(tmp, sub)), `missing subdir ${sub}`);
    }
    assert.ok(fs.existsSync(path.join(tmp, 'config.yaml')));
    const cfg = fs.readFileSync(path.join(tmp, 'config.yaml'), 'utf8');
    assert.match(cfg, /version: "0\.1\.0"/);
    assert.match(cfg, /default_scope: local/);
    assert.ok(fs.existsSync(path.join(projectDir, '.deep-memory/project-profile.json')));
    const profile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.deep-memory/project-profile.json'), 'utf8')
    );
    assert.match(profile.project_id, /^proj_[a-f0-9]{12}$/);
    assert.strictEqual(profile.privacy.scope, 'local');
    assert.strictEqual(profile.privacy.allow_export, false);
    // global mirror also written
    assert.ok(fs.existsSync(path.join(tmp, 'projects', profile.project_id + '.json')));
    assert.strictEqual(r.memoryRoot, fs.realpathSync(tmp));
    assert.strictEqual(r.projectId, profile.project_id);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('init is idempotent — running twice keeps the same project_id + does not overwrite config', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-init-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-'));
  const cwd = process.cwd();
  process.chdir(projectDir);
  try {
    const r1 = await run({ memoryRoot: tmp });
    const cfg1 = fs.readFileSync(path.join(tmp, 'config.yaml'), 'utf8');
    // user-edited config simulation
    fs.appendFileSync(path.join(tmp, 'config.yaml'), '# user comment\n');
    const r2 = await run({ memoryRoot: tmp });
    assert.strictEqual(r1.projectId, r2.projectId);
    const cfg2 = fs.readFileSync(path.join(tmp, 'config.yaml'), 'utf8');
    assert.ok(cfg2.endsWith('# user comment\n'), 'second init must not overwrite existing config');
    assert.ok(cfg2.length > cfg1.length);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('resolveMemoryRoot honors DEEP_MEMORY_ROOT env and ~ prefix', () => {
  const orig = process.env.DEEP_MEMORY_ROOT;
  try {
    delete process.env.DEEP_MEMORY_ROOT;
    assert.strictEqual(resolveMemoryRoot('~/foo'), path.join(os.homedir(), 'foo'));
    process.env.DEEP_MEMORY_ROOT = '/tmp/env-dm';
    assert.strictEqual(resolveMemoryRoot(), '/tmp/env-dm');
    assert.strictEqual(resolveMemoryRoot('/tmp/explicit'), '/tmp/explicit', 'arg wins over env');
  } finally {
    if (orig === undefined) delete process.env.DEEP_MEMORY_ROOT;
    else process.env.DEEP_MEMORY_ROOT = orig;
  }
});

test('projectId is deterministic for same cwd + remote', () => {
  const a = projectId('/tmp/proj-x');
  const b = projectId('/tmp/proj-x');
  assert.strictEqual(a, b);
  assert.match(a, /^proj_[a-f0-9]{12}$/);
  const c = projectId('/tmp/proj-y');
  assert.notStrictEqual(a, c);
});
