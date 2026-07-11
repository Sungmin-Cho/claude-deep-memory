'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectId } = require('../scripts/init');

function mkGitRepo(remote) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pid-cwd-'));
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore', shell: false });
  spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: dir, stdio: 'ignore', shell: false });
  return dir;
}

test('projectId is root-only and ignores remote changes', () => {
  const dir = mkGitRepo('https://github.com/test/repo-alpha.git');
  try {
    const before = projectId(dir);
    spawnSync('git', ['remote', 'set-url', 'origin', 'https://github.com/test/repo-beta.git'], {
      cwd: dir,
      stdio: 'ignore',
      shell: false,
    });
    assert.equal(projectId(dir), before);
    assert.match(before, /^proj_[a-f0-9]{12}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real root and its filesystem alias produce the same project id', (t) => {
  const dir = mkGitRepo('https://github.com/test/repo-alias.git');
  const alias = `${dir}-alias`;
  t.after(() => {
    fs.rmSync(alias, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(projectId(alias), projectId(fs.realpathSync.native(dir)));
});

test('different physical roots produce different project ids', () => {
  const dir1 = mkGitRepo('https://github.com/test/same.git');
  const dir2 = mkGitRepo('https://github.com/test/same.git');
  try {
    assert.notEqual(projectId(dir1), projectId(dir2));
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('projectId works for a non-git directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pid-nogit-'));
  try {
    assert.match(projectId(dir), /^proj_[a-f0-9]{12}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
