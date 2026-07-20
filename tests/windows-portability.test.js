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

test('Codex hook manifest keeps the exact supported events and one cross-shell bootstrap per event', () => {
  const hooks = JSON.parse(source('hooks/hooks.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), [
    'PostToolUse',
    'PreCompact',
    'SessionStart',
    'UserPromptSubmit',
  ]);

  for (const [event, entries] of Object.entries(hooks)) {
    const handler = onlyHandler(entries);
    // E5: one shell-safe env-bootstrap serves bash, PowerShell, and cmd alike.
    assert.match(handler.command, /^node -e "/, event);
    assert.doesNotMatch(handler.command, /[%`]/, event);
    assert.equal(handler.commandWindows, handler.command, event);
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

test('home expansion normalizes either tilde separator with the target platform path API', () => {
  const { expandHomePath } = require('../scripts/lib/path-utils');
  assert.equal(
    expandHomePath('~/memory root', {
      homeDir: 'C:\\Users\\runneradmin',
      pathApi: path.win32,
    }),
    'C:\\Users\\runneradmin\\memory root',
  );
  assert.equal(
    expandHomePath('~\\memory root', {
      homeDir: '/home/runner',
      pathApi: path.posix,
    }),
    '/home/runner/memory root',
  );
  assert.equal(
    expandHomePath('~other/literal', {
      homeDir: '/home/runner',
      pathApi: path.posix,
    }),
    '~other/literal',
  );
});

test('persisted-path redaction preserves an auditable Windows workspace path while collapsing home', () => {
  const { redactPersistedPath, redactString, REDACT_TAG } = require('../scripts/lib/redact');
  const { resolvePersistedPath } = require('../scripts/lib/path-utils');
  const homeDir = 'C:\\Users\\runneradmin';
  assert.equal(
    redactPersistedPath('D:\\a\\repo Ω\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    'D:\\a\\repo Ω\\artifact.json',
  );
  assert.equal(
    redactPersistedPath('C:\\Users\\runneradmin\\private\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~\\private\\artifact.json',
  );
  assert.equal(
    redactPersistedPath('c:\\users\\RUNNERADMIN\\private\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~\\private\\artifact.json',
    'current-home matching must be drive and case insensitive on Windows',
  );
  assert.equal(
    redactString('c:\\users\\RUNNERADMIN\\private\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~\\private\\artifact.json',
    'the final boundary must use the same case-insensitive home identity',
  );
  assert.equal(
    redactString('c:/users/RUNNERADMIN/private/artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~/private/artifact.json',
    'the final boundary must collapse a forward-slash current HOME without leaking the drive',
  );
  assert.equal(
    redactString('D:/a/repo/private docs/artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    REDACT_TAG,
    'forward-slash drive absolutes must be fully masked',
  );
  for (const absolute of [
    '//server/share/private docs/artifact.json',
    '//?/C:/Program Files/Forward Corp/artifact.json',
    '//?/UNC/server/share/private docs/artifact.json',
    String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\Users\Alice\volume private\artifact.json`,
    String.raw`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\Alice\shadow private\artifact.json`,
    '//?/Volume{12345678-1234-1234-1234-123456789abc}/Users/Alice/forward volume private/artifact.json',
    String.raw`\\?/GLOBALROOT\Device/HarddiskVolumeShadowCopy2\Users/Alice/mixed shadow private/artifact.json`,
  ]) {
    assert.equal(path.win32.isAbsolute(absolute), true, absolute);
    assert.equal(redactString(absolute, { homeDir, platform: 'win32' }), REDACT_TAG,
      `forward-slash Windows namespace must be fully masked: ${absolute}`);
  }
  assert.equal(redactString('C:notes/todo.txt', { homeDir, platform: 'win32' }), 'C:notes/todo.txt',
    'drive-relative forward-slash paths must not be misclassified as absolute');
  assert.equal(
    redactPersistedPath('\\\\?\\C:\\Users\\runneradmin\\private\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~\\private\\artifact.json',
    'the supported extended drive namespace must canonicalize before home collapse',
  );
  assert.equal(
    redactString('\\\\?\\C:\\Users\\runneradmin\\private\\artifact.json', {
      homeDir,
      platform: 'win32',
    }),
    '~\\private\\artifact.json',
    'the final boundary must never emit a malformed extended home token',
  );
  for (const [extended, finalExpected] of [
    ['//?/C:/Users/runneradmin/private docs/artifact.json', '~/private docs/artifact.json'],
    [String.raw`\\?/C:/Users/runneradmin/private docs/artifact.json`, '~/private docs/artifact.json'],
    [String.raw`//?\C:\Users\runneradmin\private docs\artifact.json`, String.raw`~\private docs\artifact.json`],
  ]) {
    assert.equal(path.win32.isAbsolute(extended), true, extended);
    assert.equal(
      redactPersistedPath(extended, { homeDir, platform: 'win32' }),
      String.raw`~\private docs\artifact.json`,
      `persisted extended current HOME must canonicalize before comparison: ${extended}`,
    );
    assert.equal(
      redactString(extended, { homeDir, platform: 'win32' }),
      finalExpected,
      `final extended current HOME must not retain a namespace prefix: ${extended}`,
    );
  }

  for (const unsafe of [
    'C:\\Users\\runneradministrator\\private docs\\artifact.json',
    'D:\\Users\\Alice\\private\\artifact.json',
    'D:\\repo\\api_key=abcdefghijklmnop\\artifact.json',
  ]) {
    const persisted = redactPersistedPath(unsafe, { homeDir, platform: 'win32' });
    assert.equal(persisted, REDACT_TAG, unsafe);
    assert.equal(resolvePersistedPath(persisted, {
      homeDir,
      pathApi: path.win32,
    }), null, `non-reversible provenance must never resolve as ${unsafe}`);
    assert.equal(redactString(persisted), REDACT_TAG, unsafe);
    assert.equal(redactString(unsafe, { homeDir, platform: 'win32' }), REDACT_TAG,
      `the final boundary must mask the complete unsafe path: ${unsafe}`);
  }

  const workspacePath = 'D:\\a\\repo Ω\\artifact.json';
  assert.equal(redactString(workspacePath), REDACT_TAG,
    'an auditable persisted workspace path must still be fully masked at the MCP boundary');
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
