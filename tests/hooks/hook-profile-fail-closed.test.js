'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveProjectId } = require('../../scripts/lib/project-resolver');
const {
  makeValidProjectProfile,
  makeSameIdInvalidProfiles,
} = require('../helpers/project-profile-fixtures');

const repoRoot = path.resolve(__dirname, '../..');
const hooks = [
  'session-start.mjs',
  'user-prompt-submit.mjs',
  'post-tool-use.mjs',
  'post-tool-failure.mjs',
  'pre-compact.mjs',
  'session-end.mjs',
];

function makeRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function writeProfile(projectRoot, value) {
  const profileDir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'project-profile.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

function eventLines(memoryRoot) {
  const file = path.join(memoryRoot, 'events', `${new Date().toISOString().slice(0, 7)}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function runHook(script, projectRoot, memoryRoot) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts/hooks', script)], {
    cwd: projectRoot,
    env: { ...process.env, PROJECT_CWD: projectRoot, DEEP_MEMORY_ROOT: memoryRoot },
    input: JSON.stringify({
      session_id: `session-${script}`,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectRoot, 'README.md'), new_string: 'changed' },
      tool_output: 'ok',
    }),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
}

for (const script of hooks) {
  test(`${script} captures only under a complete physical-root matching profile`, (t) => {
    const projectRoot = makeRoot(t, `dm-hook-project-${script}-`);
    const foreignRoot = makeRoot(t, `dm-hook-foreign-${script}-`);
    const valid = makeValidProjectProfile(projectRoot);
    const invalid = makeSameIdInvalidProfiles(valid);
    const states = [
      ['missing', null, false],
      ['invalid-json', '{', false],
      ...Object.entries(invalid).map(([name, profile]) => [name, profile, false]),
      ['foreign-id', { ...valid, project_id: deriveProjectId(foreignRoot) }, false],
      ['copied-a-to-b', makeValidProjectProfile(foreignRoot), false],
      ['matching', valid, true],
    ];

    for (const [name, profile, shouldCapture] of states) {
      fs.rmSync(path.join(projectRoot, '.deep-memory'), { recursive: true, force: true });
      if (profile !== null) writeProfile(projectRoot, profile);
      const memoryRoot = makeRoot(t, `dm-hook-memory-${script}-${name}-`);
      fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), 'capture:\n  enabled: true\n');
      const result = runHook(script, projectRoot, memoryRoot);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(result.stdout, '', name);
      const lines = eventLines(memoryRoot);
      assert.equal(lines.length, shouldCapture ? 1 : 0, `${script}/${name}`);
      if (shouldCapture) assert.equal(lines[0].envelope.project_id, valid.project_id);
    }
  });
}
