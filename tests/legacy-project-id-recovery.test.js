'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { dedupeKey } = require('../scripts/lib/dedupe');
const {
  mapRecurringFindings,
  memoryIdFor,
  buildSourceMeta,
  buildCardFromDraft,
} = require('../scripts/harvest');
const { deriveProjectId } = require('../scripts/lib/project-resolver');
const { validateAllCards, validateCardSchema } = require('../scripts/audit');

const repoRoot = path.resolve(__dirname, '..');
const sourceFixture = path.join(repoRoot, 'tests/fixtures/sample-recurring-findings.json');

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function treeDigest(paths) {
  const hash = crypto.createHash('sha256');
  for (const target of paths.sort()) {
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const child = path.join(dir, name);
          const relative = path.relative(target, child).split(path.sep).join('/');
          const childStat = fs.lstatSync(child);
          if (childStat.isDirectory()) walk(child);
          else {
            hash.update(relative);
            hash.update(fs.readFileSync(child));
          }
        }
      };
      walk(target);
    } else {
      hash.update(path.basename(target));
      hash.update(fs.readFileSync(target));
    }
  }
  return hash.digest('hex');
}

function writeAccessRecorder(fixture) {
  const preload = path.join(fixture, 'fs-access-recorder.cjs');
  fs.writeFileSync(preload, String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const append = fs.appendFileSync.bind(fs);
const blocked = JSON.parse(process.env.DM_BLOCKED_PATHS || '[]').map((p) => path.resolve(p));
const blockedListings = JSON.parse(process.env.DM_BLOCKED_LISTINGS || '[]').map((p) => path.resolve(p));
const logPath = process.env.DM_ACCESS_LOG;
function normalized(value) {
  return typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL
    ? path.resolve(value instanceof URL ? value.pathname : String(value))
    : null;
}
function record(operation, values, listingOnly = false) {
  for (const value of values) {
    const target = normalized(value);
    if (!target) continue;
    const denied = listingOnly
      ? blockedListings.includes(target)
      : blocked.some((base) => target === base || target.startsWith(base + path.sep));
    if (!denied) continue;
    append(logPath, JSON.stringify({ operation, target }) + '\n');
    throw Object.assign(new Error('sealed legacy namespace access'), { code: 'SEALED_LEGACY_ACCESS' });
  }
}
for (const name of ['accessSync', 'existsSync', 'statSync', 'lstatSync', 'readFileSync', 'openSync',
  'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    record(name, [args[0]]);
    return Reflect.apply(original, this, args);
  };
}
const originalRename = fs.renameSync;
fs.renameSync = function (...args) {
  record('renameSync', [args[0], args[1]]);
  return Reflect.apply(originalRename, this, args);
};
const originalReaddir = fs.readdirSync;
fs.readdirSync = function (...args) {
  record('readdirSync', [args[0]]);
  record('readdirSync', [args[0]], true);
  return Reflect.apply(originalReaddir, this, args);
};
const originalRealpath = fs.realpathSync;
const originalRealpathNative = originalRealpath.native;
function wrappedRealpath(...args) {
  record('realpathSync', [args[0]]);
  return Reflect.apply(originalRealpath, this, args);
}
wrappedRealpath.native = function (...args) {
  record('realpathSync.native', [args[0]]);
  return Reflect.apply(originalRealpathNative, this, args);
};
fs.realpathSync = wrappedRealpath;
`);
  return preload;
}

test('1.0.2 init and re-harvest never mutate either legacy scope or sealed index', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-legacy-recovery Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const projectDir = path.join(fixture, 'project');
  const memoryRoot = path.join(fixture, 'memory');
  fs.mkdirSync(projectDir, { recursive: true });
  const projectRoot = fs.realpathSync.native(projectDir);
  fs.mkdirSync(path.join(memoryRoot, 'indexes'), { recursive: true });

  const remoteHash = `sha256:${sha('https://example.invalid/legacy.git')}`;
  const rootHash = `sha256:${sha(projectRoot)}`;
  const remoteLegacy = `proj_${sha(`${remoteHash}|${rootHash}`).slice(0, 12)}`;
  const rootLegacy = `proj_${sha(projectRoot).slice(0, 16)}`;
  const sourceArtifact = JSON.parse(fs.readFileSync(sourceFixture, 'utf8'));
  const sourceMeta = buildSourceMeta(sourceFixture, sourceArtifact, 'review-recurring');
  const controlledDraft = mapRecurringFindings(sourceArtifact, sourceMeta)[0];
  const controlledId = memoryIdFor(
    controlledDraft.memory_type,
    dedupeKey(controlledDraft.memory_type, controlledDraft.claim, controlledDraft.applicability),
  );
  const controlledCard = buildCardFromDraft(controlledDraft, sourceMeta, projectRoot);
  assert.equal(controlledCard.payload.memory_id, controlledId);
  const remoteCard = JSON.parse(JSON.stringify(controlledCard));
  remoteCard.payload.memory_id = 'mem_failure_case_deadbeefdeadbeef';
  remoteCard.payload.claim = 'sealed remote-derived legacy row';
  remoteCard.payload.dedupe_key = `sha256:${sha('sealed remote-derived legacy row')}`;
  for (const card of [remoteCard, controlledCard]) {
    assert.equal(validateCardSchema(card), true, JSON.stringify(validateCardSchema.errors));
  }
  const legacyCards = [[remoteLegacy, remoteCard], [rootLegacy, controlledCard]];
  const legacyTrees = legacyCards.map(([scope, card]) => {
    const dir = path.join(memoryRoot, 'cards', 'failure-case', scope);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${card.payload.memory_id}.json`), JSON.stringify(card));
    return dir;
  });
  const legacyIndex = path.join(memoryRoot, 'indexes', 'lexical.sqlite');
  const index = openIndex(legacyIndex);
  upsertCard(index, remoteCard, { projectId: remoteLegacy });
  upsertCard(index, controlledCard, { projectId: rootLegacy });
  const seededRows = index.db.prepare('SELECT memory_id, project_id FROM cards ORDER BY project_id').all();
  assert.deepEqual(new Set(seededRows.map((row) => row.project_id)), new Set([remoteLegacy, rootLegacy]));
  assert.ok(seededRows.some((row) => row.memory_id === controlledId));
  closeIndex(index);
  const legacyPaths = [...legacyTrees, legacyIndex, `${legacyIndex}-wal`, `${legacyIndex}-shm`];
  const before = treeDigest(legacyPaths);
  const accessLog = path.join(fixture, 'legacy-access.jsonl');
  const preload = writeAccessRecorder(fixture);
  const recorderEnv = {
    ...process.env,
    DEEP_MEMORY_ROOT: memoryRoot,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(),
    DM_BLOCKED_PATHS: JSON.stringify(legacyPaths),
    DM_BLOCKED_LISTINGS: JSON.stringify([path.join(memoryRoot, 'cards', 'failure-case')]),
    DM_ACCESS_LOG: accessLog,
  };

  const init = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/init.js'), memoryRoot], {
    cwd: projectRoot,
    env: recorderEnv,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(init.status, 0, init.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(projectRoot, '.deep-memory/project-profile.json'), 'utf8'));
  assert.equal(profile.project_id, deriveProjectId(projectRoot));
  assert.equal(treeDigest(legacyPaths), before, 'init must leave legacy namespace byte-identical');

  const harvest = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/harvest.js'),
    sourceFixture,
    '--kind', 'review-recurring',
    '--project', profile.project_id,
  ], {
    cwd: projectRoot,
    env: recorderEnv,
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
  });
  assert.equal(harvest.status, 0, harvest.stderr);
  assert.equal(fs.existsSync(accessLog) ? fs.readFileSync(accessLog, 'utf8') : '', '',
    'init and re-harvest must not enumerate or access a sealed legacy path');
  assert.equal(treeDigest(legacyPaths), before, 're-harvest must leave legacy namespace byte-identical');
  assert.ok(fs.existsSync(path.join(memoryRoot, 'indexes/v2/lexical.sqlite')));
  const newCards = fs.readdirSync(path.join(memoryRoot, 'cards/failure-case', profile.project_id)).sort();
  assert.deepEqual(newCards, [`${controlledId}.json`]);
  const indexEntries = fs.readdirSync(path.join(memoryRoot, 'indexes'), { recursive: true })
    .map((entry) => String(entry).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(indexEntries, ['lexical.sqlite', 'v2', 'v2/lexical.sqlite']);
});

test('v2 audit scans only global plus the validated v2 project scope', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-legacy-audit-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const memoryRoot = path.join(fixture, 'memory');
  const legacyScope = 'proj_0123456789abcdef';
  const legacyDir = path.join(memoryRoot, 'cards/failure-case', legacyScope);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'must-not-open.json'), '{ malformed legacy bytes');
  const typeDir = path.dirname(legacyDir);
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (target, ...args) => {
    assert.notEqual(path.resolve(target), path.resolve(typeDir),
      'v2 audit must derive allowed scopes instead of enumerating type scopes');
    assert.ok(!path.resolve(target).startsWith(path.resolve(legacyDir) + path.sep),
      'v2 audit must not enumerate a legacy scope');
    return Reflect.apply(readdirSync, fs, [target, ...args]);
  });
  const result = validateAllCards(memoryRoot, { projectId: 'proj_aaaaaaaaaaaa' });
  assert.equal(result.total, 0);
  assert.equal(result.invalid, 0);
});
