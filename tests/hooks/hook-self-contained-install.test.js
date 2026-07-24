'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const DELIVERY_PATHS = Object.freeze([
  '.claude-plugin',
  '.codex-plugin',
  'dist',
  'hooks',
  'package.json',
  'package-lock.json',
  'schemas',
  'scripts',
]);

function copyDeliveryPath(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyDeliveryPath(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDeliveryFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-memory-install Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const relativePath of DELIVERY_PATHS) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) continue;
    copyDeliveryPath(source, path.join(fixture, relativePath));
  }
  assert.equal(fs.existsSync(path.join(fixture, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(fixture), 'node_modules')), false);
  return fixture;
}

function onlyHandler(entries) {
  const handlers = entries.flatMap((entry) => entry.hooks || []);
  assert.equal(handlers.length, 1);
  return handlers[0];
}

function bootstrapBody(command) {
  assert.match(command, /^node -e "/);
  assert.equal(command.endsWith('"'), true);
  return command.slice('node -e "'.length, -1);
}

function runManifestHook(fixture, manifestName, event, {
  memoryRoot,
  projectRoot,
  input,
} = {}) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixture, 'hooks', manifestName), 'utf8'),
  );
  const body = bootstrapBody(onlyHandler(manifest.hooks[event]).command);
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  if (manifestName === 'hooks.claude.json') env.CLAUDE_PLUGIN_ROOT = fixture;
  else env.PLUGIN_ROOT = fixture;
  if (memoryRoot) env.DEEP_MEMORY_ROOT = memoryRoot;
  if (projectRoot) env.PROJECT_CWD = projectRoot;
  return spawnSync(process.execPath, ['-e', body], {
    cwd: fixture,
    env,
    input: JSON.stringify(input || {}),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 15000,
  });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function writeCaptureConfig(memoryRoot, enabled) {
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'config.yaml'),
    `capture:\n  enabled: ${enabled ? 'true' : 'false'}\n`,
  );
}

function writeProjectProfile(projectRoot) {
  const physicalRoot = fs.realpathSync.native(projectRoot);
  const profileDir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'project-profile.json'), JSON.stringify({
    project_id: `proj_${crypto.createHash('sha256').update(physicalRoot).digest('hex').slice(0, 12)}`,
    repo: {
      remote_url_hash: sha256('no-remote'),
      root_path_hash: sha256(physicalRoot),
      default_branch: 'main',
      git_head: '',
    },
    signature: {
      languages: ['javascript'],
      runtimes: ['node'],
      topology: 'single-package',
      test_frameworks: ['node:test'],
      package_managers: ['npm'],
      agent_runtime: ['codex', 'claude-code'],
    },
    suite: { installed_plugins: ['deep-memory'] },
    privacy: { scope: 'local', allow_export: false },
    source_mtimes: {},
    generated_at: new Date().toISOString(),
  }));
}

function eventLines(memoryRoot) {
  const eventsDir = path.join(memoryRoot, 'events');
  if (!fs.existsSync(eventsDir)) return [];
  return fs.readdirSync(eventsDir)
    .sort()
    .flatMap((name) => fs.readFileSync(path.join(eventsDir, name), 'utf8')
      .split('\n').filter(Boolean));
}

test('marketplace delivery runs every registered hook capture-off without node_modules', (t) => {
  const fixture = copyDeliveryFixture(t);
  const surfaces = [
    ['hooks.json', ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact']],
    ['hooks.claude.json', [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'SessionEnd',
    ]],
  ];

  for (const [manifest, events] of surfaces) {
    for (const event of events) {
      const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-memory-off '));
      t.after(() => fs.rmSync(memoryRoot, { recursive: true, force: true }));
      writeCaptureConfig(memoryRoot, false);
      const result = runManifestHook(fixture, manifest, event, {
        memoryRoot,
        input: { hook_event_name: event, session_id: `off-${event}` },
      });
      assert.equal(result.status, 0,
        `${manifest}:${event} status=${result.status}\nstderr=${result.stderr}`);
      assert.equal(result.stdout, '', `${manifest}:${event} stdout`);
      assert.deepEqual(eventLines(memoryRoot), [], `${manifest}:${event} wrote an event`);
    }
  }
});

for (const [manifest, host] of [
  ['hooks.json', 'codex'],
  ['hooks.claude.json', 'claude-code'],
]) {
  test(`marketplace delivery captures a real redacted PostToolUse event on ${host}`, (t) => {
    const fixture = copyDeliveryFixture(t);
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `deep-memory-${host} `));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `deep-memory-project-${host} `));
    t.after(() => fs.rmSync(memoryRoot, { recursive: true, force: true }));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    writeCaptureConfig(memoryRoot, true);
    writeProjectProfile(projectRoot);
    const privatePath = path.join(os.homedir(), 'private-install-fixture.js');

    const result = runManifestHook(fixture, manifest, 'PostToolUse', {
      memoryRoot,
      projectRoot,
      input: {
        hook_event_name: 'PostToolUse',
        cwd: projectRoot,
        session_id: `enabled-${host}`,
        tool_name: 'Edit',
        tool_input: { file_path: privatePath, new_string: 'const installed = true;' },
        tool_response: `wrote ${privatePath}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const lines = eventLines(memoryRoot);
    assert.equal(lines.length, 1, `expected one event, stderr=${result.stderr}`);
    assert.equal(lines[0].includes(os.homedir()), false, 'home path must remain redacted');
    const record = JSON.parse(lines[0]);
    assert.equal(record.envelope.artifact_kind, 'memory-hook-event');
    assert.equal(record.envelope.host, host);
    assert.equal(record.payload.source_kind, 'hook-post-tool-use');
  });
}
