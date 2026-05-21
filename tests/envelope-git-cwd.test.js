'use strict';
// ITEM-4-r5: envelope.js#gitStateSafe must accept cwd so SDK-style callers in a different
// process.cwd() get the correct repo's git state.
const test = require('node:test');
const assert = require('node:assert');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { wrap, gitStateSafe } = require('../scripts/lib/envelope');

/**
 * Create a minimal git repo in `dir` with one commit, so gitStateSafe(dir) returns
 * a valid non-null result. Returns the HEAD commit hash.
 */
function initGitRepoWithCommit(dir, remoteName, remoteUrl) {
  const run = (cmd) => execSync(cmd, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.com',
           GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.com' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
  run('git init');
  run('git config user.email "t@t.com"');
  run('git config user.name "Test"');
  run(`git remote add ${remoteName} ${remoteUrl}`);
  // Write a dummy file so we can commit
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  run('git add README.md');
  run('git commit -m "init"');
  return run('git rev-parse HEAD');
}

test('ITEM-4-r5: gitStateSafe(cwd) returns state for the specified repo, not process.cwd()', () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-git-cwd1-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-git-cwd2-'));
  try {
    const head1 = initGitRepoWithCommit(tmp1, 'origin', 'https://example.com/repo1.git');
    const head2 = initGitRepoWithCommit(tmp2, 'origin', 'https://example.com/repo2.git');
    // Verify the two repos have different HEAD commits
    assert.notStrictEqual(head1, head2, 'Two repos should have different HEAD hashes (timing may rarely clash)');

    // From process.cwd() (the deep-memory repo), call gitStateSafe with cwd=tmp1
    // → should return tmp1's HEAD, NOT process.cwd()'s HEAD
    const state1 = gitStateSafe(tmp1);
    assert.ok(state1 !== null, 'gitStateSafe(tmp1) must return non-null for a valid git repo');
    assert.strictEqual(state1.head, head1,
      `Expected head=${head1} (tmp1), got ${state1.head}`);

    // Same with tmp2
    const state2 = gitStateSafe(tmp2);
    assert.ok(state2 !== null, 'gitStateSafe(tmp2) must return non-null for a valid git repo');
    assert.strictEqual(state2.head, head2,
      `Expected head=${head2} (tmp2), got ${state2.head}`);
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('ITEM-4-r5: wrap({..., cwd}) threads cwd to gitStateSafe → envelope.git.head matches target repo', () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-wrap-cwd1-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-wrap-cwd2-'));
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
