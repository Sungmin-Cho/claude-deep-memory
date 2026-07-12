'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveProjectId } = require('../scripts/lib/project-resolver');
const {
  makeValidProjectProfile,
  makeSameIdInvalidProfiles,
} = require('./helpers/project-profile-fixtures');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(repoRoot, 'scripts/harvest.js');
const artifact = path.join(repoRoot, 'tests/fixtures/sample-recurring-findings.json');

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function writeProfile(projectRoot, profile) {
  const dir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile));
}

function invoke(projectRoot, memoryRoot, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: { ...process.env, DEEP_MEMORY_ROOT: memoryRoot, PROJECT_CWD: projectRoot },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30000,
  });
}

function assertNoWrites(projectRoot, memoryRoot, label) {
  assert.equal(fs.existsSync(path.join(projectRoot, '.deep-memory/latest-harvest.json')), false, label);
  assert.equal(fs.existsSync(path.join(memoryRoot, 'indexes/v2/lexical.sqlite')), false, label);
  const cardsRoot = path.join(memoryRoot, 'cards');
  const cardFiles = fs.existsSync(cardsRoot)
    ? fs.readdirSync(cardsRoot, { recursive: true }).filter((name) => name.endsWith('.json'))
    : [];
  assert.deepEqual(cardFiles, [], label);
}

test('all harvest write entrypoints reject every untrusted profile before storage', (t) => {
  const projectRoot = fixture(t, 'dm-harvest-guard-project-');
  const foreignRoot = fixture(t, 'dm-harvest-guard-foreign-');
  const valid = makeValidProjectProfile(projectRoot);
  const projectId = deriveProjectId(projectRoot);
  const states = [
    ['missing', null],
    ['invalid-json', '{'],
    ...Object.entries(makeSameIdInvalidProfiles(valid)),
    ['foreign-id', { ...valid, project_id: deriveProjectId(foreignRoot) }],
    ['copied-a-to-b', makeValidProjectProfile(foreignRoot)],
  ];
  const argvShapes = [
    ['ordinary', [artifact, '--kind', 'review-recurring']],
    ['ordinary-explicit', [artifact, '--kind', 'review-recurring', '--project', projectId]],
    ['rebuild', ['--rebuild-from-events']],
    ['rebuild-explicit', ['--rebuild-from-events', '--project', projectId]],
  ];

  for (const [state, profile] of states) {
    for (const [shape, args] of argvShapes) {
      fs.rmSync(path.join(projectRoot, '.deep-memory'), { recursive: true, force: true });
      if (profile !== null) writeProfile(projectRoot, profile);
      const memoryRoot = fixture(t, `dm-harvest-${state}-${shape}-`);
      const result = invoke(projectRoot, memoryRoot, args);
      assert.notEqual(result.status, 0, `${state}/${shape}: stdout=${result.stdout} stderr=${result.stderr}`);
      assertNoWrites(projectRoot, memoryRoot, `${state}/${shape}`);
    }
  }
});

test('matching profile permits ordinary harvest only into derived v2 scope', (t) => {
  const projectRoot = fixture(t, 'dm-harvest-happy-project-');
  const memoryRoot = fixture(t, 'dm-harvest-happy-memory-');
  const valid = makeValidProjectProfile(projectRoot);
  writeProfile(projectRoot, valid);
  const result = invoke(projectRoot, memoryRoot, [artifact, '--kind', 'review-recurring']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(memoryRoot, 'indexes/v2/lexical.sqlite')));
  assert.ok(fs.existsSync(path.join(projectRoot, '.deep-memory/latest-harvest.json')));
  assert.equal(valid.project_id, deriveProjectId(projectRoot));
});
