'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isContainedPath,
  walkContainedCards,
  readContainedCard,
} = require('../scripts/lib/card-paths');
const { locateCard } = require('../scripts/lib/card-filters');

const PROJECT_ID = 'proj_abcdef123456';
const LEGACY_12 = 'proj_111111111111';
const LEGACY_16 = 'proj_2222222222222222';

function fixture(t, prefix = 'dm-card-paths-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function createDirectoryAlias(target, alias, {
  platform = process.platform,
  symlinkSync = fs.symlinkSync,
} = {}) {
  try {
    symlinkSync(target, alias, platform === 'win32' ? 'junction' : 'dir');
    return { available: true, alias };
  } catch (error) {
    if (platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

function createFileAlias(target, alias, {
  platform = process.platform,
  symlinkSync = fs.symlinkSync,
} = {}) {
  try {
    symlinkSync(target, alias, 'file');
    return { available: true, alias };
  } catch (error) {
    if (platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
}

function instrumentIo({ forbidden = [], forbiddenReaddir = [], realpathOverride = new Map() } = {}) {
  const accesses = [];
  const forbiddenRoots = forbidden.map((item) => path.resolve(item));
  const forbiddenListings = forbiddenReaddir.map((item) => path.resolve(item));
  function resolved(value) {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return null;
    return path.resolve(value instanceof URL ? value.pathname : String(value));
  }
  function observe(operation, value) {
    const target = resolved(value);
    if (!target) return;
    if (forbiddenRoots.some((base) => target === base || target.startsWith(`${base}${path.sep}`))) {
      accesses.push({ operation, target });
      throw Object.assign(new Error('forbidden legacy access'), { code: 'FORBIDDEN_LEGACY_ACCESS' });
    }
    if (operation === 'readdirSync' && forbiddenListings.includes(target)) {
      accesses.push({ operation, target });
      throw Object.assign(new Error('scope enumeration forbidden'), { code: 'SCOPE_ENUMERATION_FORBIDDEN' });
    }
  }
  const io = Object.create(fs);
  for (const name of ['lstatSync', 'readdirSync', 'readFileSync']) {
    io[name] = function (...args) {
      observe(name, args[0]);
      return Reflect.apply(fs[name], fs, args);
    };
  }
  function realpathImpl(value, ...rest) {
    observe('realpathSync.native', value);
    const key = resolved(value);
    if (realpathOverride.has(key)) return realpathOverride.get(key);
    return fs.realpathSync.native(value, ...rest);
  }
  const realpath = (...args) => realpathImpl(...args);
  realpath.native = (...args) => realpathImpl(...args);
  io.realpathSync = realpath;
  return { io, accesses };
}

function scan(root, currentProjectId, options = {}) {
  const seen = [];
  const result = walkContainedCards({
    root,
    currentProjectId,
    maxFiles: options.maxFiles || 5000,
    io: options.io || fs,
    platform: options.platform || process.platform,
    onCard(descriptor) { seen.push(descriptor); },
  });
  return { ...result, seen };
}

test('separator-aware containment rejects prefix traps and honors Windows case folding only via seam', () => {
  assert.equal(isContainedPath('/safe/root', '/safe/root/card.json', { platform: 'linux' }), true);
  assert.equal(isContainedPath('/safe/root', '/safe/rootish/card.json', { platform: 'linux' }), false);
  assert.equal(isContainedPath('/safe/root', '/SAFE/root/card.json', { platform: 'linux' }), false);
  assert.equal(isContainedPath('C:\\Safe\\Root', 'c:\\safe\\root\\card.json', { platform: 'win32' }), true);
  assert.equal(isContainedPath('C:\\Safe\\Root', 'c:\\safe\\rootish\\card.json', { platform: 'win32' }), false);
});

test('denied Windows junction fixture reports only the stable capability reason', () => {
  const result = createDirectoryAlias('target', 'alias', {
    platform: 'win32',
    symlinkSync() {
      throw Object.assign(new Error('junction denied'), { code: 'EPERM' });
    },
  });
  assert.deepEqual(result, { available: false, reason: 'junction_fixture_unavailable' });
});

test('walker and reader expose only global plus exact v2 scope without touching legacy namespaces', (t) => {
  const root = fixture(t);
  const typeDir = path.join(root, 'cards', 'pattern');
  const globalFile = path.join(typeDir, 'global', 'global.json');
  const localFile = path.join(typeDir, PROJECT_ID, 'local.json');
  const legacy12 = path.join(typeDir, LEGACY_12);
  const legacy16 = path.join(typeDir, LEGACY_16);
  writeJson(globalFile, { marker: 'global-card' });
  writeJson(localFile, { marker: 'local-card' });
  writeJson(path.join(legacy12, 'sealed.json'), { marker: 'legacy-12-forbidden' });
  writeJson(path.join(legacy16, 'sealed.json'), { marker: 'legacy-16-forbidden' });

  const instrumented = instrumentIo({
    forbidden: [legacy12, legacy16],
    forbiddenReaddir: [typeDir],
  });
  const local = scan(root, PROJECT_ID, { io: instrumented.io });
  assert.equal(local.visited, 2);
  assert.deepEqual(local.warnings, []);
  assert.deepEqual(local.seen.map((item) => item.scope).sort(), ['global', PROJECT_ID]);
  const values = local.seen.map((descriptor) => readContainedCard(descriptor, { io: instrumented.io }).value.marker).sort();
  assert.deepEqual(values, ['global-card', 'local-card']);
  assert.deepEqual(instrumented.accesses, []);

  const globalOnly = scan(root, null, { io: instrumented.io });
  assert.equal(globalOnly.visited, 1);
  assert.deepEqual(globalOnly.seen.map((item) => item.scope), ['global']);
  assert.deepEqual(instrumented.accesses, []);
});

test('walker rejects links at root, cards, type, scope, and file before following them', (t) => {
  const outside = fixture(t, 'dm-card-paths-outside-');
  writeJson(path.join(outside, 'outside.json'), { marker: 'outside-secret' });
  const cases = [];

  const realRoot = fixture(t, 'dm-card-paths-root-real-');
  const rootAlias = `${realRoot}-alias`;
  const rootLink = createDirectoryAlias(realRoot, rootAlias);
  t.after(() => fs.rmSync(rootAlias, { recursive: true, force: true }));
  if (rootLink.available) cases.push(['root', rootAlias]);
  else assert.equal(rootLink.reason, 'junction_fixture_unavailable');

  const cardsRoot = fixture(t, 'dm-card-paths-cards-');
  const cardsLink = createDirectoryAlias(outside, path.join(cardsRoot, 'cards'));
  if (cardsLink.available) cases.push(['cards', cardsRoot]);
  else assert.equal(cardsLink.reason, 'junction_fixture_unavailable');

  const typeRoot = fixture(t, 'dm-card-paths-type-');
  fs.mkdirSync(path.join(typeRoot, 'cards'), { recursive: true });
  const typeLink = createDirectoryAlias(outside, path.join(typeRoot, 'cards', 'pattern'));
  if (typeLink.available) cases.push(['type', typeRoot]);
  else assert.equal(typeLink.reason, 'junction_fixture_unavailable');

  const scopeRoot = fixture(t, 'dm-card-paths-scope-');
  fs.mkdirSync(path.join(scopeRoot, 'cards', 'pattern'), { recursive: true });
  const scopeLink = createDirectoryAlias(outside, path.join(scopeRoot, 'cards', 'pattern', 'global'));
  if (scopeLink.available) cases.push(['scope', scopeRoot]);
  else assert.equal(scopeLink.reason, 'junction_fixture_unavailable');

  const fileRoot = fixture(t, 'dm-card-paths-file-');
  const globalDir = path.join(fileRoot, 'cards', 'pattern', 'global');
  fs.mkdirSync(globalDir, { recursive: true });
  const fileLink = createFileAlias(path.join(outside, 'outside.json'), path.join(globalDir, 'outside.json'));
  if (fileLink.available) cases.push(['file', fileRoot]);
  else assert.equal(fileLink.reason, 'junction_fixture_unavailable');

  for (const [component, root] of cases) {
    const result = scan(root, null);
    assert.equal(result.seen.length, 0, component);
    assert.ok(result.warnings.includes('card_path_link_rejected'), `${component}: ${result.warnings}`);
    assert.doesNotMatch(JSON.stringify(result.warnings), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('lstat rejection precedes realpath and a lexical child whose physical target escapes is rejected', (t) => {
  const outside = fixture(t, 'dm-card-paths-escape-outside-');
  const root = fixture(t, 'dm-card-paths-escape-root-');
  const globalDir = path.join(root, 'cards', 'pattern', 'global');
  const lexical = path.join(globalDir, 'lexical.json');
  const outsideFile = path.join(outside, 'outside.json');
  writeJson(lexical, { marker: 'lexical' });
  writeJson(outsideFile, { marker: 'outside' });

  const override = new Map([[path.resolve(lexical), fs.realpathSync.native(outsideFile)]]);
  const { io } = instrumentIo({ realpathOverride: override });
  const escaped = scan(root, null, { io });
  assert.equal(escaped.seen.length, 0);
  assert.ok(escaped.warnings.includes('card_path_outside_scope'));

  const link = path.join(globalDir, 'linked.json');
  const alias = createFileAlias(outsideFile, link);
  if (!alias.available) {
    assert.equal(alias.reason, 'junction_fixture_unavailable');
    return;
  }
  let linkRealpathCalls = 0;
  const observed = instrumentIo();
  const originalNative = observed.io.realpathSync.native;
  observed.io.realpathSync.native = (value, ...rest) => {
    if (path.resolve(value) === path.resolve(link)) linkRealpathCalls += 1;
    return originalNative(value, ...rest);
  };
  scan(root, null, { io: observed.io });
  assert.equal(linkRealpathCalls, 0, 'link must be rejected by lstat before realpath');
});

test('maxFiles bounds callback delivery deterministically', (t) => {
  const root = fixture(t);
  for (const name of ['c.json', 'a.json', 'b.json']) {
    writeJson(path.join(root, 'cards', 'pattern', 'global', name), { marker: name });
  }
  const result = scan(root, null, { maxFiles: 2 });
  assert.equal(result.visited, 2);
  assert.deepEqual(result.seen.map((item) => path.basename(item.path)), ['a.json', 'b.json']);
  assert.ok(result.warnings.includes('card_scan_limit_reached'));
});

test('caller cannot raise the hard 5000-file invocation cap', () => {
  const directoryStat = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
  const fileStat = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
  const files = Array.from({ length: 5001 }, (_, index) => ({
    name: `${String(index).padStart(5, '0')}.json`,
  }));
  const io = {
    lstatSync(value) { return String(value).endsWith('.json') ? fileStat : directoryStat; },
    readdirSync(value) {
      return path.resolve(value) === '/memory/cards' ? [{ name: 'pattern' }] : files;
    },
    realpathSync: Object.assign((value) => path.resolve(value), {
      native: (value) => path.resolve(value),
    }),
  };
  let callbacks = 0;
  const result = walkContainedCards({
    root: '/memory',
    currentProjectId: null,
    maxFiles: 9000,
    io,
    platform: 'linux',
    onCard() { callbacks += 1; },
  });
  assert.equal(callbacks, 5000);
  assert.equal(result.visited, 5000);
  assert.ok(result.warnings.includes('card_scan_limit_reached'));
});

test('FTS-backed locateCard rejects linked and physical-escape candidates while returning a genuine current card', (t) => {
  const outside = fixture(t, 'dm-card-locate-outside-');
  const outsideFile = path.join(outside, 'outside.json');
  writeJson(outsideFile, { payload: { memory_id: 'mem_target', memory_type: 'pattern', claim: 'outside secret' } });

  const linkedRoot = fixture(t, 'dm-card-locate-link-');
  const linkedScope = path.join(linkedRoot, 'cards', 'pattern', PROJECT_ID);
  fs.mkdirSync(linkedScope, { recursive: true });
  const linked = createFileAlias(outsideFile, path.join(linkedScope, 'mem_target.json'));
  if (linked.available) {
    const result = locateCard(linkedRoot, {
      memory_id: 'mem_target',
      memory_type: 'pattern',
      project_id: PROJECT_ID,
      privacy_level: 'local',
    }, { currentProjectId: PROJECT_ID });
    assert.equal(result, null, 'a linked card must not validate an FTS row');
  } else {
    assert.equal(linked.reason, 'junction_fixture_unavailable');
  }

  const escapedRoot = fixture(t, 'dm-card-locate-escape-');
  const lexical = path.join(escapedRoot, 'cards', 'pattern', PROJECT_ID, 'mem_target.json');
  writeJson(lexical, { payload: { memory_id: 'mem_target', memory_type: 'pattern', claim: 'lexical card' } });
  const { io } = instrumentIo({
    realpathOverride: new Map([[path.resolve(lexical), fs.realpathSync.native(outsideFile)]]),
  });
  assert.equal(locateCard(escapedRoot, {
    memory_id: 'mem_target',
    memory_type: 'pattern',
    project_id: PROJECT_ID,
    privacy_level: 'local',
  }, { io, currentProjectId: PROJECT_ID }), null, 'a physical escape must fail closed');

  const genuineRoot = fixture(t, 'dm-card-locate-genuine-');
  writeJson(path.join(genuineRoot, 'cards', 'pattern', PROJECT_ID, 'mem_target.json'), {
    payload: { memory_id: 'mem_target', memory_type: 'pattern', claim: 'genuine card' },
  });
  const genuine = locateCard(genuineRoot, {
    memory_id: 'mem_target',
    memory_type: 'pattern',
    project_id: PROJECT_ID,
    privacy_level: 'local',
  }, { currentProjectId: PROJECT_ID });
  assert.equal(genuine.payload.claim, 'genuine card');
});

test('FTS-backed locateCard never traverses cards, type, or scope directory aliases', (t) => {
  const outside = fixture(t, 'dm-card-locate-dir-outside-');
  writeJson(path.join(outside, 'pattern', PROJECT_ID, 'mem_target.json'), {
    payload: { memory_id: 'mem_target', memory_type: 'pattern', claim: 'outside alias card' },
  });
  const roots = [];

  const cardsRoot = fixture(t, 'dm-card-locate-cards-alias-');
  const cardsAlias = createDirectoryAlias(outside, path.join(cardsRoot, 'cards'));
  if (cardsAlias.available) roots.push(cardsRoot);
  else assert.equal(cardsAlias.reason, 'junction_fixture_unavailable');

  const typeRoot = fixture(t, 'dm-card-locate-type-alias-');
  fs.mkdirSync(path.join(typeRoot, 'cards'), { recursive: true });
  const typeAlias = createDirectoryAlias(path.join(outside, 'pattern'), path.join(typeRoot, 'cards', 'pattern'));
  if (typeAlias.available) roots.push(typeRoot);
  else assert.equal(typeAlias.reason, 'junction_fixture_unavailable');

  const scopeRoot = fixture(t, 'dm-card-locate-scope-alias-');
  fs.mkdirSync(path.join(scopeRoot, 'cards', 'pattern'), { recursive: true });
  const scopeAlias = createDirectoryAlias(
    path.join(outside, 'pattern', PROJECT_ID),
    path.join(scopeRoot, 'cards', 'pattern', PROJECT_ID),
  );
  if (scopeAlias.available) roots.push(scopeRoot);
  else assert.equal(scopeAlias.reason, 'junction_fixture_unavailable');

  for (const root of roots) {
    const result = locateCard(root, {
      memory_id: 'mem_target',
      memory_type: 'pattern',
      project_id: PROJECT_ID,
      privacy_level: 'local',
    }, { currentProjectId: PROJECT_ID });
    assert.equal(result, null);
  }
});
