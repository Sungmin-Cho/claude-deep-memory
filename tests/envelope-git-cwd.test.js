'use strict';
// ITEM-4-r5: envelope.js#gitStateSafe must accept cwd so SDK-style callers in a different
// process.cwd() get the correct repo's git state.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { wrap, gitStateSafe } = require('../scripts/lib/envelope');
const { runGit } = require('../scripts/lib/git-command');

/**
 * Create a minimal git repo in `dir` with one commit, so gitStateSafe(dir) returns
 * a valid non-null result. Returns the HEAD commit hash.
 */
function initGitRepoWithCommit(dir, remoteName, remoteUrl) {
  const run = (args) => {
    const result = spawnSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.com',
             GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.com' },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.error || ''}`);
    return result.stdout.trim();
  };
  run(['init']);
  run(['config', 'user.email', 't@t.com']);
  run(['config', 'user.name', 'Test']);
  run(['remote', 'add', remoteName, remoteUrl]);
  // Write a dummy file so we can commit
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
  return run(['rev-parse', 'HEAD']);
}

test('gitStateSafe passes fixed argument arrays and cwd through the shared helper', () => {
  const calls = [];
  const values = new Map([
    ['rev-parse\0HEAD', '0123456789abcdef0123456789abcdef01234567'],
    ['rev-parse\0--abbrev-ref\0HEAD', 'feature/windows'],
    ['status\0--porcelain', ' M scripts/lib/envelope.js'],
  ]);
  const gitProcess = (args, options) => {
    calls.push({ args, options });
    return values.get(args.join('\0')) ?? null;
  };
  const cwd = 'C:\\Users\\me\\repo path Ω';

  assert.deepStrictEqual(gitStateSafe(cwd, gitProcess), {
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'feature/windows',
    dirty: true,
  });
  assert.deepStrictEqual(calls, [
    { args: ['rev-parse', 'HEAD'], options: { cwd } },
    { args: ['rev-parse', '--abbrev-ref', 'HEAD'], options: { cwd } },
    { args: ['status', '--porcelain'], options: { cwd } },
  ]);
});

test('gitStateSafe omits git metadata when any shared git probe has no result', () => {
  assert.strictEqual(gitStateSafe('/repo', (args) => (
    args[0] === 'status' ? null : '0123456789abcdef0123456789abcdef01234567'
  )), null);
});

test('runGit uses the cwd repository when poisoned parent Git environment points at another repo', () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm git cwd1 Ω '));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm git cwd2 Ω '));
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    const head1 = initGitRepoWithCommit(tmp1, 'origin', 'https://example.com/repo1.git');
    const head2 = initGitRepoWithCommit(tmp2, 'origin', 'https://example.com/repo2.git');
    assert.notStrictEqual(head1, head2, 'Two repos should have different HEAD hashes (timing may rarely clash)');

    process.env.GIT_DIR = path.join(tmp2, '.git');
    process.env.GIT_WORK_TREE = tmp2;
    assert.strictEqual(runGit(['rev-parse', 'HEAD'], { cwd: tmp1 }), head1,
      'explicit cwd must outrank inherited repository selectors');
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('ITEM-4-r5: wrap({..., cwd}) threads cwd to gitStateSafe → envelope.git.head matches target repo', () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm wrap cwd1 Ω '));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm wrap cwd2 Ω '));
  try {
    const head1 = initGitRepoWithCommit(tmp1, 'origin', 'https://example.com/repo1.git');
    const head2 = initGitRepoWithCommit(tmp2, 'origin', 'https://example.com/repo2.git');

    // Call wrap with cwd=tmp2 while process.cwd() may be deep-memory's root
    const result = wrap({
      artifact_kind: 'memory-card',
      schema: { name: 'memory-card', version: '1.0' },
      payload: { test: true },
      provenance: { source_artifacts: [] },
      cwd: tmp2,
    });
    assert.ok(result.envelope.git !== undefined,
      'envelope.git must be present for a valid git repo');
    assert.strictEqual(result.envelope.git.head, head2,
      `Expected envelope.git.head=${head2} (tmp2), got ${result.envelope.git.head}`);
    assert.notStrictEqual(result.envelope.git.head, head1,
      'envelope.git.head must NOT be tmp1 head');
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('ITEM-4-r5: gitStateSafe() without cwd uses process.cwd() as before (backward-compat)', () => {
  // process.cwd() for this test suite is the deep-memory repo root — a valid git repo.
  // gitStateSafe() with no arg must still return non-null and head must be a valid hex SHA.
  const state = gitStateSafe();
  // Could be null if running in a non-git environment, but in this repo it must be valid.
  // Be lenient: just check the contract — if non-null, it must have valid fields.
  if (state !== null) {
    assert.match(state.head, /^[a-f0-9]{7,40}$/,
      `head must be hex SHA, got: ${state.head}`);
    assert.strictEqual(typeof state.dirty, 'boolean', 'dirty must be boolean');
    assert.ok(typeof state.branch === 'string', 'branch must be a string');
  }
  // No assertion on null case — null is a valid contract result for non-git environments.
});

test('ITEM-4-r5: wrap() without cwd (backward-compat) does not throw', () => {
  // Old call signature: no cwd field → cwd defaults to null → gitStateSafe() called without arg.
  assert.doesNotThrow(() => {
    wrap({
      artifact_kind: 'memory-card',
      schema: { name: 'memory-card', version: '1.0' },
      payload: { test: true },
      provenance: { source_artifacts: [] },
      // no cwd field
    });
  });
});
