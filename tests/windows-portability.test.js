'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function onlyHandler(entries) {
  const handlers = entries.flatMap((entry) => entry.hooks || []);
  assert.equal(handlers.length, 1);
  return handlers[0];
}

test('adapter detection is pure and never probes an installed command', () => {
  const adapterSource = source('scripts/lib/adapter-registry.js');
  assert.doesNotMatch(adapterSource, /command\s+-v/);
  assert.doesNotMatch(adapterSource, /\bwhich\b/);
  assert.doesNotMatch(adapterSource, /\bexecSync\b/);
});

test('git command helper invokes git with argv, requested cwd, sanitized env, and no shell', () => {
  const { runGit } = require('../scripts/lib/git-command');
  const calls = [];
  const env = {
    PATH: 'C:\\Windows\\System32',
    ORDINARY_ENV: 'preserved',
    GIT_DIR: 'B:\\repo\\.git',
    git_work_tree: 'B:\\repo',
    GiT_COMMON_DIR: 'B:\\repo\\.git',
    GIT_INDEX_FILE: 'B:\\repo\\.git\\index',
    GIT_OBJECT_DIRECTORY: 'B:\\repo\\.git\\objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: 'B:\\alternate-objects',
    GIT_NAMESPACE: 'poisoned',
    GIT_CEILING_DIRECTORIES: 'B:\\',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    GIT_CONFIG: 'B:\\poisoned.gitconfig',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: 'B:\\hooks',
    GIT_CONFIG_SYSTEM: 'B:\\system.gitconfig',
    GIT_CONFIG_GLOBAL: 'B:\\global.gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath=B:\\\\hooks'",
  };
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    return { status: 0, stdout: '  abc123\r\n' };
  };

  assert.equal(runGit(['rev-parse', 'HEAD'], { cwd: 'C:\\repo path Ω', env, spawn }), 'abc123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].argv, ['rev-parse', 'HEAD']);
  assert.equal(calls[0].options.cwd, 'C:\\repo path Ω');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.deepEqual(calls[0].options.env, {
    PATH: 'C:\\Windows\\System32',
    ORDINARY_ENV: 'preserved',
  });
});

test('git command helper returns null for nonzero and ENOENT without accepting shell strings', () => {
  const { runGit } = require('../scripts/lib/git-command');
  assert.equal(runGit(['status', '--porcelain'], {
    spawn: () => ({ status: 1, stdout: 'ignored' }),
  }), null);
  assert.equal(runGit(['rev-parse', 'HEAD'], {
    spawn: () => { throw Object.assign(new Error('missing git'), { code: 'ENOENT' }); },
  }), null);
  assert.throws(() => runGit('git status --porcelain'), /argument array/i);
});

test('init and envelope contain no shell-based git execution', () => {
  for (const relativePath of ['scripts/init.js', 'scripts/lib/envelope.js']) {
    const text = source(relativePath);
    assert.doesNotMatch(text, /\bexecSync\b/, relativePath);
    assert.doesNotMatch(text, /shell\s*:\s*true/, relativePath);
    assert.doesNotMatch(text, /['"`]git\s+[^'"`]+['"`]/, relativePath);
  }
});

test('brief delegates both JSON and Markdown publishing to shared atomic writers', () => {
  const text = source('scripts/brief.js');
  assert.match(text, /\{\s*writeJsonAtomic\s*,\s*writeTextAtomic\s*\}/);
  assert.match(text, /writeJsonAtomic\(jsonPath, json\)/);
  assert.match(text, /writeTextAtomic\(mdPath, md\)/);
  assert.doesNotMatch(text, /\brenameSync\b/);
  assert.doesNotMatch(text, /\bfsyncSync\b/);
});

test('Codex hook manifest keeps the exact supported events and quoted dual-host handlers', () => {
  const hooks = JSON.parse(source('hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    'PostToolUse',
    'PreCompact',
    'SessionStart',
    'UserPromptSubmit',
  ]);

  for (const [event, entries] of Object.entries(hooks)) {
    const handler = onlyHandler(entries);
    assert.match(handler.command, /^node "\$\{PLUGIN_ROOT\}\//, event);
    assert.match(handler.commandWindows, /^node "%PLUGIN_ROOT%\\/, event);
  }
});

test('directory fsync treats only unsupported platform errors as best effort', () => {
  const { fsyncDirectoryBestEffort } = require('../scripts/lib/atomic-write');
  for (const code of ['EPERM', 'EINVAL', 'EBADF', 'ENOTSUP']) {
    let closed = false;
    const io = {
      openSync: () => 42,
      fsyncSync: () => { throw Object.assign(new Error(code), { code }); },
      closeSync: (fd) => { assert.equal(fd, 42); closed = true; },
    };
    assert.equal(fsyncDirectoryBestEffort('C:\\memory', io), false, code);
    assert.equal(closed, true, `${code}: descriptor must be closed`);
  }

  let closed = false;
  const io = {
    openSync: () => 7,
    fsyncSync: () => { throw Object.assign(new Error('storage failure'), { code: 'EIO' }); },
    closeSync: (fd) => { assert.equal(fd, 7); closed = true; },
  };
  assert.throws(() => fsyncDirectoryBestEffort('C:\\memory', io), { code: 'EIO' });
  assert.equal(closed, true, 'unexpected storage error must still close the descriptor');
});

test('network path detection recognizes UNC and extended UNC only on Windows', () => {
  const { isNetworkPath } = require('../scripts/lib/preflight');
  assert.equal(isNetworkPath('\\\\server\\share\\memory', 'win32'), true);
  assert.equal(isNetworkPath('\\\\?\\UNC\\server\\share\\memory', 'win32'), true);
  assert.equal(isNetworkPath('\\\\?\\C:\\Users\\me\\memory', 'win32'), false);
  assert.equal(isNetworkPath('\\\\.\\PhysicalDrive0', 'win32'), false);
  assert.equal(isNetworkPath('C:\\Users\\me\\memory', 'win32'), false);
  assert.equal(isNetworkPath('/Volumes/team/memory', 'darwin'), true);
  assert.equal(isNetworkPath('/mnt/team/memory', 'linux'), true);
  assert.equal(isNetworkPath('/net/team/memory', 'linux'), true);
  assert.equal(isNetworkPath('/home/me/memory', 'linux'), false);
});

test('atomic JSON and text writes use unique private temps in Unicode paths with no leftovers', (t) => {
  const { writeJsonAtomic, writeTextAtomic } = require('../scripts/lib/atomic-write');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm atomic Ω path '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jsonPath = path.join(dir, '기억 card.json');
  const textPath = path.join(dir, '기억 brief.md');
  const tempPaths = [];
  const renameSync = fs.renameSync;

  fs.renameSync = (from, to) => {
    if (to === jsonPath || to === textPath) tempPaths.push(from);
    return renameSync(from, to);
  };
  try {
    writeJsonAtomic(jsonPath, { version: 1 });
    writeJsonAtomic(jsonPath, { version: 2 });
    writeTextAtomic(textPath, 'first');
    writeTextAtomic(textPath, 'second');
  } finally {
    fs.renameSync = renameSync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), { version: 2 });
  assert.equal(fs.readFileSync(textPath, 'utf8'), 'second');
  assert.equal(tempPaths.length, 4);
  assert.equal(new Set(tempPaths).size, 4, 'every publish must use a unique private temp path');
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [path.basename(jsonPath), path.basename(textPath)].sort(),
    'successful writes must not leave temporary files behind',
  );
});
