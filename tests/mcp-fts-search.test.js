'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFtsSearch } = require('../scripts/lib/mcp-fts-search');

const PROJECT_A = 'proj_aaaaaaaaaaaa';
const PROJECT_B = 'proj_bbbbbbbbbbbb';

let fts = null;
try { fts = require('../scripts/lib/fts-index'); } catch { /* native driver unavailable */ }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-fts Ω '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function writeCard(root, {
  memoryId,
  projectId = PROJECT_A,
  privacyLevel = 'local',
  claim = 'retry with backoff',
  status = 'active',
} = {}) {
  const scope = privacyLevel === 'global' ? 'global' : projectId;
  const dir = path.join(root, 'cards', 'pattern', scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${memoryId}.json`), JSON.stringify({
    payload: {
      memory_id: memoryId,
      memory_type: 'pattern',
      privacy_level: privacyLevel,
      project_id: privacyLevel === 'global' ? '' : projectId,
      claim,
      status,
      tags: ['retry'],
      applicability: [],
      non_applicability: [],
      search_keywords: ['backoff'],
    },
  }));
}

test('makeFtsSearch falls back to a structured card scan without creating a missing index', (t) => {
  const root = fixture(t);
  const search = makeFtsSearch(root);
  const result = search({ query: 'anything', currentProjectId: PROJECT_A, topK: 10 });
  assert.deepEqual(result.rows, []);
  assert.equal(result.stream, 'card-scan');
  assert.ok(result.warnings.includes('lexical_stream_fallback'));
  assert.equal(fs.existsSync(path.join(root, 'indexes', 'v2', 'lexical.sqlite')), false);
  assert.equal(fs.existsSync(path.join(root, 'indexes', 'lexical.sqlite')), false);
});

test('makeFtsSearch queries only the v2 native index and reports fts5 truthfully', { skip: !fts }, (t) => {
  const root = fixture(t);
  const dbPath = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
  const idx = fts.openIndex(dbPath);
  fts.upsertCard(idx, {
    memory_id: 'mem_pattern_abc',
    memory_type: 'pattern',
    privacy_level: 'local',
    project_id: PROJECT_A,
    claim: 'retry the flaky network call with exponential backoff',
    tags: ['network', 'retry'],
    applicability: [],
    search_keywords: ['backoff', 'retry'],
  }, { projectId: PROJECT_A });
  fts.closeIndex(idx);

  const search = makeFtsSearch(root);
  const result = search({ query: 'retry backoff', currentProjectId: PROJECT_A, topK: 10 });
  assert.equal(result.stream, 'fts5');
  assert.deepEqual(result.warnings, []);
  assert.ok(result.rows.length >= 1, `expected >=1 row, got ${JSON.stringify(result)}`);
  assert.equal(result.rows[0].memory_id, 'mem_pattern_abc');
  assert.equal(result.rows[0].project_id, PROJECT_A);
  assert.match(result.rows[0].claim, /backoff/);
});

test('native-loader failure returns a matching card scan and redacts the loader path', (t) => {
  const root = fixture(t);
  writeCard(root, { memoryId: 'mem_fallback', claim: 'retry backoff after loader failure' });
  const search = makeFtsSearch(root, {
    loadFts: () => {
      throw new Error("Cannot find module '/Users/jane/Library/pnpm/better-sqlite3/build/Release/better_sqlite3.node'");
    },
  });
  const result = search({ query: 'retry backoff', currentProjectId: PROJECT_A, topK: 10 });
  assert.equal(result.stream, 'card-scan');
  assert.deepEqual(result.rows.map((row) => row.memory_id), ['mem_fallback']);
  assert.ok(result.warnings.includes('lexical_stream_fallback'));
  for (const warning of result.warnings) {
    assert.equal(warning.includes('/Users/'), false, warning);
  }
});

test('loader fallback propagates a truthful card-scan stream through runHybridRetrieve', async (t) => {
  const { runHybridRetrieve } = require('../scripts/lib/retrieve-hybrid');
  const root = fixture(t);
  writeCard(root, { memoryId: 'mem_fallback', claim: 'retry backoff after loader failure' });
  const search = makeFtsSearch(root, {
    loadFts: () => {
      throw new Error("Cannot find module '/Users/jane/private/better_sqlite3.node'");
    },
  });
  const result = await runHybridRetrieve({
    query: 'retry backoff',
    currentProjectId: PROJECT_A,
    root,
    ftsSearch: search,
    topN: 5,
    useVector: false,
  });
  assert.deepEqual(result.memories.map((row) => row.memory_id), ['mem_fallback']);
  assert.deepEqual(result.streams_used, ['card-scan']);
  assert.ok(result.warnings.includes('lexical_stream_fallback'));
  assert.equal(result.warnings.some((warning) => warning.startsWith('fts_stream_error:')), false);
  assert.equal(result.warnings.some((warning) => warning.includes('/Users/')), false);
});

test('native runtime query failure closes the index, scans cards, and redacts the native error', (t) => {
  const root = fixture(t);
  const dbPath = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'native candidate');
  writeCard(root, { memoryId: 'mem_runtime_fallback', claim: 'retry after native query failure' });
  let closed = 0;
  const search = makeFtsSearch(root, {
    loadFts: () => ({
      openIndex: () => ({ marker: 'index' }),
      search: () => { throw new Error('native query failed at /Users/jane/private/index.sqlite'); },
      closeIndex: () => { closed += 1; },
    }),
  });
  const result = search({ query: 'retry', currentProjectId: PROJECT_A, topK: 10 });
  assert.equal(closed, 1);
  assert.equal(result.stream, 'card-scan');
  assert.deepEqual(result.rows.map((row) => row.memory_id), ['mem_runtime_fallback']);
  assert.ok(result.warnings.includes('lexical_stream_fallback'));
  assert.equal(result.warnings.some((warning) => warning.includes('/Users/')), false);
});

test('privacy scope prevents another project from seeing local cards in native or fallback retrieval', async (t) => {
  const root = fixture(t);
  writeCard(root, { memoryId: 'mem_local_a', projectId: PROJECT_A, claim: 'project a local secret pattern' });
  const fallback = makeFtsSearch(root, { loadFts: () => { throw new Error('driver absent'); } });
  const fallbackResult = fallback({ query: 'secret pattern', currentProjectId: PROJECT_B, topK: 10 });
  assert.deepEqual(fallbackResult.rows, []);
  assert.equal(fallbackResult.stream, 'card-scan');

  if (fts) {
    const dbPath = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
    const idx = fts.openIndex(dbPath);
    fts.upsertCard(idx, {
      memory_id: 'mem_local_a', memory_type: 'pattern', privacy_level: 'local',
      project_id: PROJECT_A, claim: 'project a local secret pattern', tags: [], applicability: [], search_keywords: [],
    }, { projectId: PROJECT_A });
    fts.closeIndex(idx);
    const nativeResult = makeFtsSearch(root)({ query: 'secret pattern', currentProjectId: PROJECT_B, topK: 10 });
    assert.deepEqual(nativeResult.rows, []);
    assert.equal(nativeResult.stream, 'fts5');
  }
});

test('native selection and fallback never inspect the sealed old index or legacy card scopes', (t) => {
  const root = fixture(t);
  const oldIndex = path.join(root, 'indexes', 'lexical.sqlite');
  const legacy12 = path.join(root, 'cards', 'pattern', 'proj_111111111111');
  const legacy16 = path.join(root, 'cards', 'pattern', 'proj_2222222222222222');
  fs.mkdirSync(path.dirname(oldIndex), { recursive: true });
  fs.writeFileSync(oldIndex, 'sealed old index');
  writeCard(root, { memoryId: 'mem_allowed', claim: 'retry allowed current' });
  writeCard(root, { memoryId: 'mem_legacy12', projectId: 'proj_111111111111', claim: 'retry sealed legacy' });
  writeCard(root, { memoryId: 'mem_legacy16', projectId: 'proj_2222222222222222', claim: 'retry sealed legacy' });
  const accesses = [];
  const io = Object.create(fs);
  function guard(name, value) {
    const target = path.resolve(String(value));
    if ([oldIndex, legacy12, legacy16].some((base) => target === path.resolve(base) || target.startsWith(`${path.resolve(base)}${path.sep}`))
      || (name === 'readdirSync' && target === path.resolve(path.dirname(legacy12)))) {
      accesses.push({ name, target });
      throw new Error('sealed namespace accessed');
    }
  }
  for (const name of ['existsSync', 'lstatSync', 'readdirSync', 'readFileSync', 'openSync']) {
    io[name] = function (...args) { guard(name, args[0]); return Reflect.apply(fs[name], fs, args); };
  }
  function realpath(value, ...args) {
    guard('realpathSync.native', value);
    return fs.realpathSync.native(value, ...args);
  }
  io.realpathSync = Object.assign((...args) => realpath(...args), { native: (...args) => realpath(...args) });

  const fallback = makeFtsSearch(root, {
    io,
    loadFts: () => { throw new Error('native unavailable'); },
  })({ query: 'retry', currentProjectId: PROJECT_A, topK: 10 });
  assert.deepEqual(fallback.rows.map((row) => row.memory_id), ['mem_allowed']);
  assert.equal(fallback.stream, 'card-scan');
  assert.deepEqual(accesses, []);

  const v2Index = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
  fs.mkdirSync(path.dirname(v2Index), { recursive: true });
  fs.writeFileSync(v2Index, 'v2 candidate');
  const native = makeFtsSearch(root, {
    io,
    loadFts: () => ({
      openIndex: (candidate) => ({ candidate }),
      search: (index) => {
        assert.equal(path.resolve(index.candidate), path.resolve(v2Index));
        return [];
      },
      closeIndex: () => {},
    }),
  })({ query: 'retry', currentProjectId: PROJECT_A, topK: 10 });
  assert.equal(native.stream, 'fts5');
  assert.deepEqual(accesses, []);
});
