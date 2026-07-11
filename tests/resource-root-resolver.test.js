'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRuntimeRoots } = require('../scripts/lib/resource-root-resolver');
const { resolveProjectScope } = require('../scripts/lib/project-resolver');

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createDirectoryAlias(target, alias, {
  platform = process.platform,
  symlinkSync = fs.symlinkSync,
} = {}) {
  try {
    symlinkSync(target, alias, platform === 'win32' ? 'junction' : 'dir');
    return { available: true, alias };
  } catch (error) {
    if (platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

test('plugin cwd is not silently reused as workspace root', (t) => {
  const root = fixture(t, 'dm-root-identity-');
  const pluginRoot = path.join(root, 'fixture plugin root');
  fs.mkdirSync(pluginRoot);
  const physicalPluginRoot = fs.realpathSync.native(pluginRoot);
  const roots = resolveRuntimeRoots({
    env: { PLUGIN_ROOT: pluginRoot, HOME: path.join(root, 'home') },
    cwd: pluginRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(roots.pluginRoot, physicalPluginRoot);
  assert.equal(roots.workspaceRoot, null);
});

test('PROJECT_CWD remains distinct from a plugin path containing spaces', (t) => {
  const root = fixture(t, 'dm-distinct-roots-');
  const pluginRoot = path.join(root, 'fixture plugin root with spaces');
  const workspaceRoot = path.join(root, 'fixture workspace with spaces');
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(workspaceRoot);
  const roots = resolveRuntimeRoots({
    env: {
      PLUGIN_ROOT: pluginRoot,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: path.join(root, 'memory root'),
    },
    cwd: pluginRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(roots.pluginRoot, fs.realpathSync.native(pluginRoot));
  assert.equal(roots.workspaceRoot, fs.realpathSync.native(workspaceRoot));
  assert.equal(roots.memoryRoot, path.resolve(root, 'memory root'));
});

test('source and bundled entry directories resolve to the same plugin root', (t) => {
  const root = fixture(t, 'dm-entry-root-');
  const pluginRoot = path.join(root, 'plugin');
  fs.mkdirSync(pluginRoot);
  const source = resolveRuntimeRoots({ env: {}, cwd: pluginRoot, entryDir: path.join(pluginRoot, 'scripts') });
  const bundle = resolveRuntimeRoots({ env: {}, cwd: pluginRoot, entryDir: path.join(pluginRoot, 'dist') });
  assert.equal(source.pluginRoot, fs.realpathSync.native(pluginRoot));
  assert.equal(bundle.pluginRoot, fs.realpathSync.native(pluginRoot));
});

test('missing profile is global-only even when workspace root is readable', (t) => {
  const workspace = fixture(t, 'dm-profile-free-');
  const scope = resolveProjectScope(fs.realpathSync.native(workspace));
  assert.equal(scope.scope, 'global');
  assert.equal(scope.projectId, null);
});

test('physical aliases of plugin root are never accepted as workspace roots', (t) => {
  const root = fixture(t, 'dm-root-alias-');
  const pluginRoot = path.join(root, 'plugin real');
  const pluginAlias = path.join(root, 'plugin alias');
  const workspaceRoot = path.join(root, 'workspace real');
  const workspaceAlias = path.join(root, 'workspace alias');
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(workspaceRoot);
  const pluginLink = createDirectoryAlias(pluginRoot, pluginAlias);
  const workspaceLink = createDirectoryAlias(workspaceRoot, workspaceAlias);
  if (!pluginLink.available || !workspaceLink.available) {
    assert.equal((!pluginLink.available ? pluginLink : workspaceLink).reason, 'junction_fixture_unavailable');
    return;
  }

  for (const [plugin, workspace] of [[pluginRoot, pluginAlias], [pluginAlias, pluginRoot]]) {
    const roots = resolveRuntimeRoots({
      env: { PLUGIN_ROOT: plugin, PROJECT_CWD: workspace },
      cwd: workspace,
      entryDir: path.join(pluginRoot, 'dist'),
    });
    assert.equal(roots.pluginRoot, fs.realpathSync.native(pluginRoot));
    assert.equal(roots.workspaceRoot, null);
  }

  const distinct = resolveRuntimeRoots({
    env: { PLUGIN_ROOT: pluginAlias, PROJECT_CWD: workspaceAlias },
    cwd: pluginRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(distinct.workspaceRoot, fs.realpathSync.native(workspaceRoot));
});

test('denied Windows runtime-root junction fixture reports a stable capability reason', (t) => {
  const root = fixture(t, 'dm-root-junction-seam-');
  const result = createDirectoryAlias(root, path.join(root, 'alias'), {
    platform: 'win32',
    symlinkSync() {
      throw Object.assign(new Error('junction denied'), { code: 'EPERM' });
    },
  });
  assert.deepEqual(result, { available: false, reason: 'junction_fixture_unavailable' });
});

test('guarded cwd fallback preserves Claude workspace and rejects Codex plugin cwd', (t) => {
  const root = fixture(t, 'dm-cwd-shapes-');
  const pluginRoot = path.join(root, 'plugin');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(workspaceRoot);

  const claude = resolveRuntimeRoots({
    env: { PLUGIN_ROOT: pluginRoot },
    cwd: workspaceRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(claude.workspaceRoot, fs.realpathSync.native(workspaceRoot));

  const codex = resolveRuntimeRoots({
    env: { PLUGIN_ROOT: pluginRoot },
    cwd: pluginRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(codex.workspaceRoot, null);

  const explicit = resolveRuntimeRoots({
    env: { PLUGIN_ROOT: pluginRoot, PROJECT_CWD: workspaceRoot },
    cwd: pluginRoot,
    entryDir: path.join(pluginRoot, 'dist'),
  });
  assert.equal(explicit.workspaceRoot, fs.realpathSync.native(workspaceRoot));
});
