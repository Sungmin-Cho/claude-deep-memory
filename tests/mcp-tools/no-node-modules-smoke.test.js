'use strict';
// Installed-artifact contract: marketplace/cache installs may contain only the
// manifest, package metadata, and committed bundle. Retrieval and gate audit
// must still work without plugin node_modules or source schemas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('../helpers/mcp-session');
const { writeValidProjectProfile } = require('../helpers/project-profile-fixtures');

const repoRoot = path.resolve(__dirname, '../..');

function writeCard(memoryRoot, {
  memoryId,
  scope,
  projectId,
  privacyLevel = 'local',
  claim,
  status = 'active',
} = {}) {
  const dir = path.join(memoryRoot, 'cards', 'pattern', scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${memoryId}.json`), JSON.stringify({
    payload: {
      memory_id: memoryId,
      memory_type: 'pattern',
      privacy_level: privacyLevel,
      project_id: privacyLevel === 'global' ? '' : projectId,
      claim,
      status,
      tags: ['artifact', 'retry'],
      applicability: [],
      non_applicability: [],
      search_keywords: ['fallback'],
      confidence: 0.9,
      evidence_summary: [],
    },
  }));
}

function writeAccessRecorder(fixture) {
  const preload = path.join(fixture, 'sealed access recorder.cjs');
  fs.writeFileSync(preload, String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const blocked = JSON.parse(process.env.DM_BLOCKED_PATHS || '[]').map((value) => path.resolve(value));
const blockedListings = JSON.parse(process.env.DM_BLOCKED_LISTINGS || '[]').map((value) => path.resolve(value));
const log = process.env.DM_ACCESS_LOG;
function normalize(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return null;
  return path.resolve(value instanceof URL ? value.pathname : String(value));
}
function guard(operation, value, listingOnly = false) {
  const target = normalize(value);
  if (!target) return;
  const denied = listingOnly
    ? blockedListings.includes(target)
    : blocked.some((base) => target === base || target.startsWith(base + path.sep));
  if (!denied) return;
  append(log, JSON.stringify({ operation }) + '\n');
  throw Object.assign(new Error('sealed legacy namespace access'), { code: 'SEALED_LEGACY_ACCESS' });
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

async function pollGateViolation(memoryRoot) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const dir = path.join(memoryRoot, 'audit-log');
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean));
      if (entries.some((line) => JSON.parse(line).kind === 'gate-violation')) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

test('installed MCP artifact retrieves scoped cards and records gate denial without node_modules', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm installed artifact Ω '));
  let session = null;
  t.after(async () => {
    if (session) await session.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const pluginRoot = path.join(fixture, 'plugin root Ω');
  const workspaceRoot = path.join(fixture, 'workspace root Ω');
  const memoryRoot = path.join(fixture, 'memory root Ω');
  fs.mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  for (const relative of ['.mcp.json', 'package.json', 'dist/mcp-server.cjs']) {
    const target = path.join(pluginRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  assert.equal(fs.existsSync(path.join(pluginRoot, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'schemas')), false);

  const profile = writeValidProjectProfile(workspaceRoot);
  const otherProject = 'proj_bbbbbbbbbbbb';
  writeCard(memoryRoot, {
    memoryId: 'mem_current_allowed',
    scope: profile.project_id,
    projectId: profile.project_id,
    claim: 'artifact retry current fallback',
  });
  writeCard(memoryRoot, {
    memoryId: 'mem_global_allowed',
    scope: 'global',
    projectId: profile.project_id,
    privacyLevel: 'global',
    claim: 'artifact retry global fallback',
  });
  writeCard(memoryRoot, {
    memoryId: 'mem_other_forbidden',
    scope: otherProject,
    projectId: otherProject,
    claim: 'artifact retry current fallback',
  });
  writeCard(memoryRoot, {
    memoryId: 'mem_deprecated_forbidden',
    scope: profile.project_id,
    projectId: profile.project_id,
    claim: 'artifact retry current fallback',
    status: 'deprecated',
  });

  const legacy12 = path.join(memoryRoot, 'cards', 'pattern', 'proj_111111111111');
  const legacy16 = path.join(memoryRoot, 'cards', 'pattern', 'proj_2222222222222222');
  writeCard(memoryRoot, {
    memoryId: 'mem_legacy12',
    scope: 'proj_111111111111',
    projectId: 'proj_111111111111',
    claim: 'artifact retry sealed legacy',
  });
  writeCard(memoryRoot, {
    memoryId: 'mem_legacy16',
    scope: 'proj_2222222222222222',
    projectId: 'proj_2222222222222222',
    claim: 'artifact retry sealed legacy',
  });
  const oldIndex = path.join(memoryRoot, 'indexes', 'lexical.sqlite');
  fs.mkdirSync(path.dirname(oldIndex), { recursive: true });
  fs.writeFileSync(oldIndex, 'sealed old lexical index');

  const accessLog = path.join(fixture, 'sealed-access.jsonl');
  const preload = writeAccessRecorder(fixture);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = manifest.mcpServers['deep-memory'];
  session = openMcpSession(server.command, server.args, {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(),
      DM_BLOCKED_PATHS: JSON.stringify([legacy12, legacy16, oldIndex]),
      DM_BLOCKED_LISTINGS: JSON.stringify([path.join(memoryRoot, 'cards', 'pattern')]),
      DM_ACCESS_LOG: accessLog,
    },
    timeoutMs: 10000,
  });
  const initialized = await session.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'installed-no-node-modules', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'deep-memory');
  session.notify('notifications/initialized', {});
  assert.equal(session.initializedWritten, true);

  const listed = await session.request('tools/list', {});
  assert.equal(listed.result.tools.length, 10);
  const names = new Set(listed.result.tools.map((tool) => tool.name));
  for (const name of ['deep_memory_brief', 'deep_memory_recall', 'deep_memory_export']) {
    assert.ok(names.has(name), name);
  }

  const recall = await session.request('tools/call', {
    name: 'deep_memory_recall',
    arguments: { query: 'artifact retry current fallback', limit: 10 },
  });
  assert.equal(recall.result.isError, undefined);
  const body = JSON.parse(recall.result.content[0].text);
  assert.deepEqual(body.memories.map((item) => item.memory_id), [
    'mem_current_allowed',
    'mem_global_allowed',
  ]);
  assert.deepEqual(body.streams_used, ['card-scan']);
  assert.ok(body.warnings.includes('lexical_stream_fallback'));

  const denied = await session.request('tools/call', {
    name: 'deep_memory_forget',
    arguments: { memory_id: 'mem_denied' },
  });
  assert.equal(denied.result.isError, true);
  const audit = await pollGateViolation(memoryRoot);
  assert.equal(audit.filter((line) => JSON.parse(line).kind === 'gate-violation').length, 1);
  assert.equal(fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8') : '', '');
  assert.deepEqual(session.protocolErrors, []);
  assert.equal(session.stderr, '');
});
