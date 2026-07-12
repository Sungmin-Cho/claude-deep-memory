'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('../helpers/mcp-session');
const { makeValidProjectProfile, writeValidProjectProfile } = require('../helpers/project-profile-fixtures');
const { readResource } = require('../../scripts/lib/mcp-resources');

const root = path.resolve(__dirname, '../..');

function fixture(t, prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return fs.realpathSync.native(value);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function createAlias(target, alias, type) {
  try {
    fs.symlinkSync(target, alias, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return { available: true };
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

async function openServer(t, workspaceRoot, memoryRoot, extraEnv = {}) {
  const session = openMcpSession(process.execPath, [path.join(root, 'scripts/mcp-server.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      PLUGIN_ROOT: root,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
      ...extraEnv,
    },
    timeoutMs: 10000,
  });
  t.after(() => session.close());
  await session.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'resource-containment', version: '1' },
  });
  session.notify('notifications/initialized');
  return session;
}

async function readStats(session) {
  const response = await session.request('resources/read', { uri: 'deep-memory://cards-stats' });
  return {
    raw: JSON.stringify(response.result),
    value: JSON.parse(response.result.contents[0].text),
  };
}

function writeAccessRecorder(rootDir) {
  const preload = path.join(rootDir, 'resource-access-recorder.cjs');
  fs.writeFileSync(preload, String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const forbidden = JSON.parse(process.env.DM_FORBIDDEN_CARD_SCOPES || '[]').map((value) => path.resolve(value));
const forbiddenListing = path.resolve(process.env.DM_FORBIDDEN_SCOPE_LISTING || '.');
const log = process.env.DM_FORBIDDEN_ACCESS_LOG;
function target(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return null;
  return path.resolve(value instanceof URL ? value.pathname : String(value));
}
function guard(operation, value, listing = false) {
  const resolved = target(value);
  if (!resolved) return;
  const denied = listing
    ? resolved === forbiddenListing
    : forbidden.some((base) => resolved === base || resolved.startsWith(base + path.sep));
  if (!denied) return;
  append(log, JSON.stringify({ operation }) + '\n');
  throw Object.assign(new Error('forbidden legacy scope access'), { code: 'FORBIDDEN_LEGACY_ACCESS' });
}
for (const name of ['accessSync', 'existsSync', 'statSync', 'lstatSync', 'readFileSync', 'openSync']) {
  const original = fs[name];
  fs[name] = function (...args) { guard(name, args[0]); return Reflect.apply(original, this, args); };
}
const originalReaddir = fs.readdirSync;
fs.readdirSync = function (...args) {
  guard('readdirSync', args[0]);
  guard('readdirSync', args[0], true);
  return Reflect.apply(originalReaddir, this, args);
};
const originalRealpath = fs.realpathSync;
const originalNative = originalRealpath.native;
function wrappedRealpath(...args) { guard('realpathSync', args[0]); return Reflect.apply(originalRealpath, this, args); }
wrappedRealpath.native = function (...args) { guard('realpathSync.native', args[0]); return Reflect.apply(originalNative, this, args); };
fs.realpathSync = wrappedRealpath;
`);
  return preload;
}

test('real cards-stats excludes file/type/scope aliases and external data', async (t) => {
  const workspaceRoot = fixture(t, 'dm-resource-containment-workspace-');
  const memoryRoot = fixture(t, 'dm-resource-containment-memory-');
  const outside = fixture(t, 'dm-resource-containment-outside-');
  const profile = writeValidProjectProfile(workspaceRoot);
  writeJson(path.join(memoryRoot, 'cards', 'pattern', 'global', 'good.json'), { marker: 'good-global' });
  fs.writeFileSync(path.join(memoryRoot, 'cards', 'pattern', 'global', 'malformed.json'), '{');
  writeJson(path.join(memoryRoot, 'cards', 'failure-case', profile.project_id, 'good.json'), { marker: 'good-local' });
  writeJson(path.join(outside, 'secret.json'), { marker: 'external-card-secret' });
  writeJson(path.join(outside, 'global', 'secret.json'), { marker: 'external-scope-secret' });

  const aliases = [
    createAlias(outside, path.join(memoryRoot, 'cards', 'external-type'), 'dir'),
  ];
  fs.mkdirSync(path.join(memoryRoot, 'cards', 'scope-alias-type'), { recursive: true });
  aliases.push(createAlias(outside, path.join(memoryRoot, 'cards', 'scope-alias-type', profile.project_id), 'dir'));
  aliases.push(createAlias(
    path.join(outside, 'secret.json'),
    path.join(memoryRoot, 'cards', 'pattern', 'global', 'linked.json'),
    'file',
  ));
  for (const alias of aliases) {
    if (!alias.available) assert.equal(alias.reason, 'junction_fixture_unavailable');
  }

  const session = await openServer(t, workspaceRoot, memoryRoot);
  try {
    const result = await readStats(session);
    assert.equal(result.value.available, true);
    assert.equal(result.value.total, 3);
    assert.deepEqual(result.value.by_type, { 'failure-case': 1, pattern: 2 });
    assert.doesNotMatch(result.raw, /external-card-secret|external-scope-secret|external-type|scope-alias-type/);
    assert.equal(result.raw.includes(outside), false);
    for (const warning of result.value.warnings || []) {
      assert.match(warning, /^(?:card_path|card_json)_[a-z_]+$/);
    }
    assert.ok(result.value.warnings.includes('card_json_invalid'));
  } finally {
    await session.close();
  }
});

test('cards component alias is rejected before type enumeration', async (t) => {
  const memoryRoot = fixture(t, 'dm-resource-cards-link-memory-');
  const outside = fixture(t, 'dm-resource-cards-link-outside-');
  writeJson(path.join(outside, 'pattern', 'global', 'secret.json'), { marker: 'external-cards-root' });
  const alias = createAlias(outside, path.join(memoryRoot, 'cards'), 'dir');
  if (!alias.available) {
    assert.equal(alias.reason, 'junction_fixture_unavailable');
    return;
  }
  const result = await readResource('deep-memory://cards-stats', {
    memoryRoot,
    workspaceRoot: null,
    projectScope: { scope: 'global', projectId: null },
  });
  const text = result.contents[0].text;
  assert.doesNotMatch(text, /external-cards-root|pattern/);
  assert.equal(text.includes(outside), false);
  const parsed = JSON.parse(text);
  assert.equal(parsed.total, 0);
  assert.ok(parsed.warnings.includes('card_path_link_rejected'));
});

test('unsafe injected project IDs fail before any card filesystem access', async () => {
  const unsafe = [
    '../escape',
    'global',
    'proj_abc/def',
    'proj_abc\\def',
    String.raw`C:\Users\Alice\scope`,
    String.raw`\\server\share\scope`,
    String.raw`\\?\C:\scope`,
    String.raw`\\?\UNC\server\share\scope`,
    String.raw`\\.\PhysicalDrive0`,
    'proj_2222222222222222',
  ];
  for (const projectId of unsafe) {
    const accesses = [];
    const io = new Proxy(fs, {
      get(target, prop) {
        if (['lstatSync', 'realpathSync', 'readdirSync', 'readFileSync'].includes(String(prop))) {
          return (...args) => { accesses.push([String(prop), args[0]]); throw new Error('filesystem must not run'); };
        }
        return target[prop];
      },
    });
    const result = await readResource('deep-memory://cards-stats', {
      memoryRoot: '/not-accessed',
      workspaceRoot: null,
      projectScope: { scope: 'project', projectId },
      io,
    });
    const parsed = JSON.parse(result.contents[0].text);
    assert.deepEqual(parsed, { available: false, reason: 'project_scope_invalid' }, projectId);
    assert.deepEqual(accesses, [], projectId);
  }
});

test('unknown resource URI returns a bounded response without echoing caller input', async () => {
  const callerControlled = String.raw`deep-memory://unknown/C:\Users\Alice\private\token=abcdefghijklmnop`;
  const result = await readResource(callerControlled, {
    memoryRoot: '/not-accessed',
    workspaceRoot: null,
    projectScope: { scope: 'global', projectId: null },
  });
  assert.equal(result.contents[0].uri, 'deep-memory://unknown');
  assert.deepEqual(JSON.parse(result.contents[0].text), {
    available: false,
    reason: 'unknown_resource',
  });
  assert.equal(JSON.stringify(result).includes(callerControlled), false);
});

test('retired 1.0.1 profile IDs are global-only and legacy scope paths remain sealed', async (t) => {
  const workspaceRoot = fixture(t, 'dm-resource-retired-workspace-');
  const memoryRoot = fixture(t, 'dm-resource-retired-memory-');
  const typeDir = path.join(memoryRoot, 'cards', 'pattern');
  const legacyIds = ['proj_111111111111', 'proj_2222222222222222'];
  writeJson(path.join(typeDir, 'global', 'global.json'), { marker: 'global-visible' });
  for (const id of legacyIds) writeJson(path.join(typeDir, id, 'sealed.json'), { marker: `sealed-${id}` });
  const preload = writeAccessRecorder(memoryRoot);
  for (const id of legacyIds) {
    const profileDir = path.join(workspaceRoot, '.deep-memory');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'project-profile.json'), JSON.stringify({
      ...makeValidProjectProfile(workspaceRoot),
      project_id: id,
    }));
    const accessLog = path.join(memoryRoot, `legacy-access-${id}.jsonl`);
    const session = await openServer(t, workspaceRoot, memoryRoot, {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(),
      DM_FORBIDDEN_CARD_SCOPES: JSON.stringify(legacyIds.map((value) => path.join(typeDir, value))),
      DM_FORBIDDEN_SCOPE_LISTING: typeDir,
      DM_FORBIDDEN_ACCESS_LOG: accessLog,
    });
    try {
      const result = await readStats(session);
      assert.equal(result.value.total, 1, id);
      assert.deepEqual(result.value.by_type, { pattern: 1 }, id);
      assert.equal(fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8') : '', '', id);
    } finally {
      await session.close();
    }
  }
});
