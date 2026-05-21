'use strict';
// ITEM-6-r4: safeGit now accepts cwd so projectId() is unaffected by
// process.cwd() changes — each repo's remote is read from its own directory.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { projectId } = require('../scripts/init');

function mkGitRepo(remote) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pid-cwd-'));
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('projectId(cwd) is stable — calling twice returns same result', () => {
  const dir = mkGitRepo('https://github.com/test/repo-stable.git');
  try {
    const id1 = projectId(dir);
    const id2 = projectId(dir);
    assert.strictEqual(id1, id2, 'projectId must be deterministic');
    assert.match(id1, /^proj_[a-f0-9]{12}$/, 'projectId must match format');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('projectId(cwd) differs for repos with different remotes', () => {
  const dir1 = mkGitRepo('https://github.com/test/repo-alpha.git');
  const dir2 = mkGitRepo('https://github.com/test/repo-beta.git');
  try {
    const id1 = projectId(dir1);
    const id2 = projectId(dir2);
    assert.notStrictEqual(id1, id2, 'different remotes must produce different project_ids');
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('projectId(dir1) is unaffected by process.chdir(dir2)', () => {
  const dir1 = mkGitRepo('https://github.com/test/repo-gamma.git');
  const dir2 = mkGitRepo('https://github.com/test/repo-delta.git');
  const originalCwd = process.cwd();
  try {
    // Capture stable IDs while in original cwd
    const id1 = projectId(dir1);
    const id2 = projectId(dir2);

    // Change process.cwd() to dir2
    process.chdir(dir2);

    // projectId(dir1) must not be affected by cwd change
    const id1AfterChdir = projectId(dir1);
    assert.strictEqual(
      id1,
      id1AfterChdir,
      `projectId(dir1) changed after chdir(dir2): was ${id1}, got ${id1AfterChdir}`
    );

    // projectId(dir2) must also be stable from dir2 as explicit arg
    const id2AfterChdir = projectId(dir2);
    assert.strictEqual(
      id2,
      id2AfterChdir,
      `projectId(dir2) changed: was ${id2}, got ${id2AfterChdir}`
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('projectId works for non-git directories (safeGit returns empty string gracefully)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pid-nogit-'));
  try {
    const id = projectId(dir);
    // Even without git, must return a valid format id (remote = '' → remoteHash = sha256:none)
    assert.match(id, /^proj_[a-f0-9]{12}$/, `projectId must match format for non-git dir: ${id}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
