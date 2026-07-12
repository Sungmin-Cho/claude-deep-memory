'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateProjectProfile } = require('../scripts/lib/project-profile-validator');
const { deriveProjectId, resolveProjectScope } = require('../scripts/lib/project-resolver');
const { projectId: initProjectId } = require('../scripts/init');
const {
  makeValidProjectProfile,
  makeSameIdInvalidProfiles,
} = require('./helpers/project-profile-fixtures');

function makeFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function writeProfile(root, value) {
  const dir = path.join(root, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-profile.json'), typeof value === 'string' ? value : JSON.stringify(value));
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

test('full project profile is accepted and every same-ID invalid shape is rejected', (t) => {
  const root = makeFixture(t, 'dm-profile-validator-');
  const valid = makeValidProjectProfile(root);
  assert.deepEqual(validateProjectProfile(valid), { valid: true, profile: valid });
  for (const [name, invalid] of Object.entries(makeSameIdInvalidProfiles(valid))) {
    assert.deepEqual(
      validateProjectProfile(invalid),
      { valid: false, reason: 'project_profile_schema_invalid' },
      name,
    );
  }
});

test('project-profile validator is the sole runtime schema importer', () => {
  const scriptsRoot = path.resolve(__dirname, '../scripts');
  const importers = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:c?js|mjs)$/.test(entry.name)
          && fs.readFileSync(target, 'utf8').includes('project-profile.schema.json')) {
        importers.push(path.relative(scriptsRoot, target).split(path.sep).join('/'));
      }
    }
  };
  visit(scriptsRoot);
  assert.deepEqual(importers.sort(), ['lib/project-profile-validator.js']);
});

test('profile written by production init is accepted', (t) => {
  const projectRoot = makeFixture(t, 'dm-init-profile-project-');
  const memoryRoot = makeFixture(t, 'dm-init-profile-memory-');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/init.js'), memoryRoot], {
    cwd: projectRoot,
    env: { ...process.env, DEEP_MEMORY_ROOT: memoryRoot },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(projectRoot, '.deep-memory/project-profile.json'), 'utf8'));
  assert.equal(validateProjectProfile(profile).valid, true);
});

test('resolver trusts only a complete profile matching the physical root', (t) => {
  const rootA = makeFixture(t, 'dm-profile-a-');
  const rootB = makeFixture(t, 'dm-profile-b-');
  const validA = makeValidProjectProfile(rootA);

  const states = [
    ['missing', null, 'global', null],
    ['invalid JSON', '{', 'global', null],
    ...Object.entries(makeSameIdInvalidProfiles(validA)).map(([name, value]) => [name, value, 'global', null]),
    ['foreign', { ...validA, project_id: deriveProjectId(rootB) }, 'global', null],
    ['matching', validA, 'project', deriveProjectId(rootA)],
  ];

  for (const [name, profile, scope, projectId] of states) {
    fs.rmSync(path.join(rootA, '.deep-memory'), { recursive: true, force: true });
    if (profile !== null) writeProfile(rootA, profile);
    const resolved = resolveProjectScope(rootA);
    assert.equal(resolved.scope, scope, name);
    assert.equal(resolved.projectId, projectId, name);
  }
});

test('profile copied from project A to B and 1.0.1 legacy id fail closed', (t) => {
  const rootA = makeFixture(t, 'dm-profile-copy-a-');
  const rootB = makeFixture(t, 'dm-profile-copy-b-');
  const validA = makeValidProjectProfile(rootA);
  writeProfile(rootB, validA);
  assert.deepEqual(
    { scope: resolveProjectScope(rootB).scope, projectId: resolveProjectScope(rootB).projectId },
    { scope: 'global', projectId: null },
  );

  const legacy = { ...makeValidProjectProfile(rootB), project_id: 'proj_0123456789ab' };
  writeProfile(rootB, legacy);
  assert.deepEqual(
    { scope: resolveProjectScope(rootB).scope, projectId: resolveProjectScope(rootB).projectId },
    { scope: 'global', projectId: null },
  );
});

test('physical project aliases preserve matching trust and reject a copied foreign profile', (t) => {
  const fixture = makeFixture(t, 'dm-profile-alias-');
  const rootA = path.join(fixture, 'project-a');
  const rootB = path.join(fixture, 'project-b');
  const aliasAPath = path.join(fixture, 'alias-a');
  const aliasBPath = path.join(fixture, 'alias-b');
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const aliasA = createDirectoryAlias(rootA, aliasAPath);
  const aliasB = createDirectoryAlias(rootB, aliasBPath);
  if (!aliasA.available || !aliasB.available) {
    assert.equal((!aliasA.available ? aliasA : aliasB).reason, 'junction_fixture_unavailable');
    return;
  }

  const validA = makeValidProjectProfile(rootA);
  writeProfile(rootA, validA);
  const matching = resolveProjectScope(aliasA.alias);
  assert.equal(matching.scope, 'project');
  assert.equal(matching.projectId, deriveProjectId(rootA));
  assert.equal(deriveProjectId(aliasA.alias), deriveProjectId(rootA));
  assert.equal(initProjectId(aliasA.alias), matching.projectId);

  writeProfile(rootB, validA);
  const copied = resolveProjectScope(aliasB.alias);
  assert.equal(copied.scope, 'global');
  assert.equal(copied.projectId, null);
});

test('denied Windows junction fixture reports a stable capability reason', (t) => {
  const root = makeFixture(t, 'dm-profile-junction-seam-');
  const result = createDirectoryAlias(root, path.join(root, 'alias'), {
    platform: 'win32',
    symlinkSync() {
      throw Object.assign(new Error('junction denied'), { code: 'EPERM' });
    },
  });
  assert.deepEqual(result, { available: false, reason: 'junction_fixture_unavailable' });
});
