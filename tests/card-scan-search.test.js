'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanCards } = require('../scripts/lib/card-scan-search');
const { locateCard } = require('../scripts/lib/card-filters');

const PROJECT = 'proj_aaaaaaaaaaaa';
const OTHER_PROJECT = 'proj_bbbbbbbbbbbb';
const LEGACY_12 = 'proj_111111111111';
const LEGACY_16 = 'proj_2222222222222222';

function fixture(t, prefix = 'dm-card scan Ω ') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function card({
  memoryId,
  memoryType = 'pattern',
  privacyLevel = 'local',
  projectId = PROJECT,
  claim,
  status = 'active',
  tags = [],
  applicability = [],
  nonApplicability = [],
  searchKeywords = [],
} = {}) {
  return {
    payload: {
      memory_id: memoryId,
      memory_type: memoryType,
      privacy_level: privacyLevel,
      project_id: privacyLevel === 'global' ? '' : projectId,
      claim,
      status,
      tags,
      applicability,
      non_applicability: nonApplicability,
      search_keywords: searchKeywords,
    },
  };
}

function writeCard(root, scope, value, file = `${value.payload.memory_id}.json`) {
  const dir = path.join(root, 'cards', value.payload.memory_type, scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  return path.join(dir, file);
}

function createDirectoryAlias(target, alias) {
  try {
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return { available: true };
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

function createFileAlias(target, alias) {
  try {
    fs.symlinkSync(target, alias, 'file');
    return { available: true };
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

function observedIo({ forbidden = [], forbiddenListings = [], realpathOverride = new Map(), reads = [] } = {}) {
  const accesses = [];
  const blocked = forbidden.map((value) => path.resolve(value));
  const blockedListings = forbiddenListings.map((value) => path.resolve(value));
  const io = Object.create(fs);
  function normalize(value) {
    return path.resolve(value instanceof URL ? value.pathname : String(value));
  }
  function guard(operation, value) {
    const resolved = normalize(value);
    if (blocked.some((base) => resolved === base || resolved.startsWith(`${base}${path.sep}`))
      || (operation === 'readdirSync' && blockedListings.includes(resolved))) {
      accesses.push({ operation, resolved });
      throw Object.assign(new Error('sealed namespace access'), { code: 'SEALED_NAMESPACE_ACCESS' });
    }
    if (operation === 'readFileSync') reads.push(resolved);
  }
  for (const name of ['lstatSync', 'readdirSync', 'readFileSync', 'existsSync', 'openSync']) {
    io[name] = function (...args) {
      guard(name, args[0]);
      return Reflect.apply(fs[name], fs, args);
    };
  }
  function realpath(value, ...rest) {
    guard('realpathSync.native', value);
    const key = normalize(value);
    if (realpathOverride.has(key)) return realpathOverride.get(key);
    return fs.realpathSync.native(value, ...rest);
  }
  io.realpathSync = Object.assign((...args) => realpath(...args), { native: (...args) => realpath(...args) });
  return { io, accesses, reads };
}

test('scanCards ranks exact current/global matches and excludes other, deprecated, malformed, and non-matching cards', (t) => {
  const root = fixture(t);
  const local = card({ memoryId: 'mem_local', claim: 'retry with exponential backoff' });
  const global = card({ memoryId: 'mem_global', privacyLevel: 'global', claim: 'retry safely' });
  writeCard(root, PROJECT, local);
  writeCard(root, 'global', global);
  writeCard(root, OTHER_PROJECT, card({ memoryId: 'mem_other', projectId: OTHER_PROJECT, claim: 'retry backoff private' }));
  writeCard(root, PROJECT, card({ memoryId: 'mem_deprecated', claim: 'retry backoff obsolete', status: 'deprecated' }));
  writeCard(root, PROJECT, card({ memoryId: 'mem_unrelated', claim: 'schema validation only' }));
  const malformed = path.join(root, 'cards', 'pattern', PROJECT, 'malformed.json');
  fs.writeFileSync(malformed, '{ not-json');

  const legacy12 = path.join(root, 'cards', 'pattern', LEGACY_12);
  const legacy16 = path.join(root, 'cards', 'pattern', LEGACY_16);
  const oldIndex = path.join(root, 'indexes', 'lexical.sqlite');
  writeCard(root, LEGACY_12, card({ memoryId: 'mem_legacy12', projectId: LEGACY_12, claim: 'retry backoff sealed' }));
  writeCard(root, LEGACY_16, card({ memoryId: 'mem_legacy16', projectId: LEGACY_16, claim: 'retry backoff sealed' }));
  fs.mkdirSync(path.dirname(oldIndex), { recursive: true });
  fs.writeFileSync(oldIndex, 'sealed old index');
  const observed = observedIo({ forbidden: [legacy12, legacy16, oldIndex], forbiddenListings: [path.dirname(legacy12)] });

  const result = scanCards({
    root,
    currentProjectId: PROJECT,
    query: 'retry backoff',
    topK: 10,
    io: observed.io,
  });
  assert.equal(result.stream, 'card-scan');
  assert.deepEqual(result.rows.map((row) => row.memory_id), ['mem_local', 'mem_global']);
  assert.ok(result.rows.every((row) => row.project_id === PROJECT || row.privacy_level === 'global'));
  assert.ok(result.warnings.some((warning) => warning.includes('malformed')));
  assert.deepEqual(observed.accesses, []);

  const located = locateCard(root, result.rows[0], { io: observed.io, currentProjectId: PROJECT });
  assert.equal((located.payload || located).memory_id, 'mem_local');
  assert.deepEqual(observed.accesses, []);
});

test('scanCards handles Unicode tokens and a memory root containing spaces', (t) => {
  const root = fixture(t, 'dm 카드 scan space Ω ');
  writeCard(root, PROJECT, card({
    memoryId: 'mem_unicode',
    claim: '네트워크 재시도 백오프 전략',
    tags: ['안정성'],
    searchKeywords: ['재시도'],
  }));
  const result = scanCards({ root, currentProjectId: PROJECT, query: '재시도 백오프', topK: 5 });
  assert.deepEqual(result.rows.map((row) => row.memory_id), ['mem_unicode']);
  assert.equal(result.stream, 'card-scan');
});

test('scanCards hard-stops at 5000 candidates and never reads candidate 5001', (t) => {
  const root = fixture(t, 'dm-card-scan-limit-');
  let finalFile;
  for (let index = 0; index < 5001; index += 1) {
    const memoryId = `mem_${String(index).padStart(5, '0')}`;
    const file = writeCard(root, 'global', card({
      memoryId,
      privacyLevel: 'global',
      claim: 'retry bounded scan',
    }), `${String(index).padStart(5, '0')}.json`);
    if (index === 5000) finalFile = path.resolve(file);
  }
  const reads = [];
  const observed = observedIo({ reads });
  const result = scanCards({ root, currentProjectId: null, query: 'retry', topK: 1, io: observed.io });
  assert.equal(result.rows.length, 1);
  assert.ok(result.warnings.includes('scan_limit_reached: 5000'));
  assert.equal(reads.length, 5000);
  assert.equal(reads.includes(finalFile), false);
});

test('scanner rejects cards/type/scope/file aliases and physical file escapes without leaking outside paths', (t) => {
  const outside = fixture(t, 'dm-card-scan-outside-');
  const secret = writeCard(outside, 'global', card({ memoryId: 'mem_outside', privacyLevel: 'global', claim: 'retry secret' }));
  const roots = [];

  const cardsRoot = fixture(t, 'dm-card-scan-cards-link-');
  const cardsAlias = createDirectoryAlias(path.join(outside, 'cards'), path.join(cardsRoot, 'cards'));
  if (cardsAlias.available) roots.push(cardsRoot);
  else assert.equal(cardsAlias.reason, 'junction_fixture_unavailable');

  const typeRoot = fixture(t, 'dm-card-scan-type-link-');
  fs.mkdirSync(path.join(typeRoot, 'cards'), { recursive: true });
  const typeAlias = createDirectoryAlias(path.join(outside, 'cards', 'pattern'), path.join(typeRoot, 'cards', 'pattern'));
  if (typeAlias.available) roots.push(typeRoot);
  else assert.equal(typeAlias.reason, 'junction_fixture_unavailable');

  const scopeRoot = fixture(t, 'dm-card-scan-scope-link-');
  fs.mkdirSync(path.join(scopeRoot, 'cards', 'pattern'), { recursive: true });
  const scopeAlias = createDirectoryAlias(path.dirname(secret), path.join(scopeRoot, 'cards', 'pattern', 'global'));
  if (scopeAlias.available) roots.push(scopeRoot);
  else assert.equal(scopeAlias.reason, 'junction_fixture_unavailable');

  const fileRoot = fixture(t, 'dm-card-scan-file-link-');
  fs.mkdirSync(path.join(fileRoot, 'cards', 'pattern', 'global'), { recursive: true });
  const fileAlias = createFileAlias(secret, path.join(fileRoot, 'cards', 'pattern', 'global', 'linked.json'));
  if (fileAlias.available) roots.push(fileRoot);
  else assert.equal(fileAlias.reason, 'junction_fixture_unavailable');

  for (const root of roots) {
    const result = scanCards({ root, currentProjectId: null, query: 'retry', topK: 5 });
    assert.deepEqual(result.rows, []);
    assert.ok(result.warnings.some((warning) => warning.includes('link_rejected')));
    assert.equal(JSON.stringify(result.warnings).includes(outside), false);
  }

  const escapeRoot = fixture(t, 'dm-card-scan-realpath-escape-');
  const lexical = writeCard(escapeRoot, 'global', card({ memoryId: 'mem_lexical', privacyLevel: 'global', claim: 'retry lexical' }));
  const override = new Map([[path.resolve(lexical), fs.realpathSync.native(secret)]]);
  const observed = observedIo({ realpathOverride: override });
  const escaped = scanCards({ root: escapeRoot, currentProjectId: null, query: 'retry', topK: 5, io: observed.io });
  assert.deepEqual(escaped.rows, []);
  assert.ok(escaped.warnings.some((warning) => warning.includes('outside_scope')));

  const genuineRoot = fixture(t, 'dm-card-scan-genuine-');
  writeCard(genuineRoot, PROJECT, card({ memoryId: 'mem_genuine', claim: 'retry genuine' }));
  const genuine = scanCards({ root: genuineRoot, currentProjectId: PROJECT, query: 'retry', topK: 5 });
  assert.deepEqual(genuine.rows.map((row) => row.memory_id), ['mem_genuine']);
});

test('scanCards rejects unsafe project IDs before filesystem access', () => {
  const accesses = [];
  const io = new Proxy(fs, {
    get(target, key) {
      if (['lstatSync', 'realpathSync', 'readdirSync', 'readFileSync'].includes(String(key))) {
        return (...args) => { accesses.push([String(key), args[0]]); throw new Error('filesystem must not run'); };
      }
      return target[key];
    },
  });
  assert.throws(
    () => scanCards({ root: '/never-read', currentProjectId: '../escape', query: 'retry', io }),
    (error) => error && error.code === 'INVALID_PROJECT_ID',
  );
  assert.deepEqual(accesses, []);
});
