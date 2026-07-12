'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { deriveProjectId } = require('../scripts/lib/project-resolver');
const { openMcpSession } = require('./helpers/mcp-session');
const {
  makeValidProjectProfile,
  makeSameIdInvalidProfiles,
} = require('./helpers/project-profile-fixtures');

const repoRoot = path.resolve(__dirname, '..');

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function wrappedCard(memoryId, scope) {
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '1.0.2',
      artifact_kind: 'memory-card',
      run_id: `run-${memoryId}`,
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: `fixture/${memoryId}.json` }], tool_versions: {} },
    },
    payload: {
      memory_id: memoryId,
      memory_type: 'failure-case',
      privacy_level: scope === 'global' ? 'global' : 'local',
      claim: `surface guard searchable ${memoryId}`,
      tags: ['surface-guard'],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: ['surface', 'guard', 'searchable'],
      evidence_summary: ['fixture'],
      confidence: 0.9,
      status: 'candidate',
      dedupe_key: `sha256:${Buffer.from(memoryId).toString('hex').padEnd(64, '0').slice(0, 64)}`,
    },
  };
}

function plant(memoryRoot, wrapped, scope) {
  const cardDir = path.join(memoryRoot, 'cards', wrapped.payload.memory_type, scope);
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, `${wrapped.payload.memory_id}.json`), JSON.stringify(wrapped));
  const index = openIndex(path.join(memoryRoot, 'indexes/v2/lexical.sqlite'));
  try { upsertCard(index, wrapped, { projectId: scope === 'global' ? '' : scope }); }
  finally { closeIndex(index); }
}

function writeProfile(projectRoot, value) {
  const dir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-profile.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeAccessRecorder(memoryRoot) {
  const preload = path.join(memoryRoot, 'surface-access-recorder.cjs');
  fs.writeFileSync(preload, String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const forbidden = JSON.parse(process.env.DM_FORBIDDEN_CARD_SCOPES || '[]').map((value) => path.resolve(value));
const forbiddenListing = path.resolve(process.env.DM_FORBIDDEN_SCOPE_LISTING);
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
  append(log, JSON.stringify({ operation, target: resolved }) + '\n');
  throw Object.assign(new Error('forbidden local-card probe'), { code: 'FORBIDDEN_LOCAL_PROBE' });
}
for (const name of ['accessSync', 'existsSync', 'statSync', 'lstatSync', 'readFileSync', 'openSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    guard(name, args[0]);
    return Reflect.apply(original, this, args);
  };
}
const originalReaddir = fs.readdirSync;
fs.readdirSync = function (...args) {
  guard('readdirSync', args[0]);
  guard('readdirSync', args[0], true);
  return Reflect.apply(originalReaddir, this, args);
};
const originalRealpath = fs.realpathSync;
const originalNative = originalRealpath.native;
function wrappedRealpath(...args) {
  guard('realpathSync', args[0]);
  return Reflect.apply(originalRealpath, this, args);
}
wrappedRealpath.native = function (...args) {
  guard('realpathSync.native', args[0]);
  return Reflect.apply(originalNative, this, args);
};
fs.realpathSync = wrappedRealpath;
`);
  return preload;
}

async function runSurface(projectRoot, memoryRoot, { preload, accessLog, forbiddenScopes, forbiddenListing }) {
  const session = openMcpSession(process.execPath, [path.join(repoRoot, 'dist/mcp-server.cjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(),
      DM_FORBIDDEN_CARD_SCOPES: JSON.stringify(forbiddenScopes),
      DM_FORBIDDEN_SCOPE_LISTING: forbiddenListing,
      DM_FORBIDDEN_ACCESS_LOG: accessLog,
      PLUGIN_ROOT: repoRoot,
      PROJECT_CWD: projectRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
    },
    timeoutMs: 8000,
  });
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'surface-guard', version: '1' },
    });
    session.notify('notifications/initialized');
    const recall = await session.request('tools/call', {
      name: 'deep_memory_recall',
      arguments: { query: 'surface guard searchable', limit: 10 },
    });
    const resources = await session.request('resources/list');
    const resourceReads = [];
    for (const resource of resources.result.resources) {
      resourceReads.push(await session.request('resources/read', { uri: resource.uri }));
    }
    return { recall, resourceReads, session };
  } finally {
    await session.close();
  }
}

test('MCP tools and every advertised resource stay global-only for untrusted profiles', async (t) => {
  const projectRoot = fixture(t, 'dm-surface-project-');
  const foreignRoot = fixture(t, 'dm-surface-foreign-');
  const memoryRoot = fixture(t, 'dm-surface-memory Ω ');
  const projectId = deriveProjectId(projectRoot);
  const foreignProjectId = deriveProjectId(foreignRoot);
  plant(memoryRoot, wrappedCard('surface_global_allowed', 'global'), 'global');
  plant(memoryRoot, wrappedCard('surface_local_forbidden', projectId), projectId);
  plant(memoryRoot, wrappedCard('surface_foreign_forbidden', foreignProjectId), foreignProjectId);
  const forbiddenScopes = [projectId, foreignProjectId]
    .map((scope) => path.join(memoryRoot, 'cards', 'failure-case', scope));
  const forbiddenListing = path.dirname(forbiddenScopes[0]);
  const preload = writeAccessRecorder(memoryRoot);
  const valid = makeValidProjectProfile(projectRoot);
  const states = [
    ['missing', null],
    ['invalid-json', '{'],
    ...Object.entries(makeSameIdInvalidProfiles(valid)),
    ['foreign-id', { ...valid, project_id: deriveProjectId(foreignRoot) }],
    ['copied-a-to-b', makeValidProjectProfile(foreignRoot)],
  ];
  for (const [name, profile] of states) {
    fs.rmSync(path.join(projectRoot, '.deep-memory'), { recursive: true, force: true });
    if (profile !== null) writeProfile(projectRoot, profile);
    const localStateDir = path.join(projectRoot, '.deep-memory');
    fs.mkdirSync(localStateDir, { recursive: true });
    fs.writeFileSync(path.join(localStateDir, 'latest-brief.json'), JSON.stringify({
      marker: 'surface_local_brief_forbidden',
    }));
    fs.writeFileSync(path.join(localStateDir, 'latest-distill.json'), JSON.stringify({
      marker: 'surface_local_distill_forbidden',
    }));
    const accessLog = path.join(memoryRoot, `forbidden-access-${name}.jsonl`);
    const result = await runSurface(projectRoot, memoryRoot, {
      preload, accessLog, forbiddenScopes, forbiddenListing,
    });
    const recallText = result.recall.result.content.map((item) => item.text || '').join('\n');
    assert.match(recallText, /surface_global_allowed/, name);
    assert.doesNotMatch(recallText, /surface_local_forbidden/, name);
    assert.doesNotMatch(recallText, /surface_foreign_forbidden/, name);
    const resourceText = JSON.stringify(result.resourceReads);
    assert.doesNotMatch(resourceText, /surface_local_forbidden/, name);
    assert.doesNotMatch(resourceText, /surface_foreign_forbidden/, name);
    assert.doesNotMatch(resourceText, /surface_local_brief_forbidden/, name);
    assert.doesNotMatch(resourceText, /surface_local_distill_forbidden/, name);
    assert.deepEqual(result.session.protocolErrors, [], name);
    assert.equal(fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8') : '', '',
      `${name}: local card scope must not be probed`);
  }
});

test('MCP mutation denial is surfaced and writes a gate-violation audit record', async (t) => {
  const projectRoot = fixture(t, 'dm-surface-gate-project-');
  const memoryRoot = fixture(t, 'dm-surface-gate-memory-');
  writeProfile(projectRoot, makeValidProjectProfile(projectRoot));
  const session = openMcpSession(process.execPath, [path.join(repoRoot, 'dist/mcp-server.cjs')], {
    cwd: repoRoot,
    env: { ...process.env, PLUGIN_ROOT: repoRoot, PROJECT_CWD: projectRoot, DEEP_MEMORY_ROOT: memoryRoot },
  });
  t.after(() => session.close());
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'surface-gate', version: '1' },
    });
    session.notify('notifications/initialized');
    const denied = await session.request('tools/call', {
      name: 'deep_memory_forget', arguments: { memory_id: 'mem_blocked' },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /slash_only/);
    const deadline = Date.now() + 3000;
    let auditText = '';
    while (Date.now() < deadline) {
      const auditDir = path.join(memoryRoot, 'audit-log');
      if (fs.existsSync(auditDir)) {
        auditText = fs.readdirSync(auditDir).map((name) => fs.readFileSync(path.join(auditDir, name), 'utf8')).join('\n');
        if (/gate-violation/.test(auditText)) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(auditText, /gate-violation/);
  } finally {
    await session.close();
  }
});
