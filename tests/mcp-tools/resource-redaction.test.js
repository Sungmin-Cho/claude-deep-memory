'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactString, redactPersistedPath, REDACT_TAG } = require('../../scripts/lib/redact');
const { openMcpSession } = require('../helpers/mcp-session');
const { foreignWindowsFixture } = require('../helpers/windows-path-fixtures');

const root = path.resolve(__dirname, '../..');
const GENERIC_WINDOWS_FIXTURE = foreignWindowsFixture();
const WINDOWS_PATHS = [
  String.raw`C:\Users\O'Neil Smith\private docs\secret.txt`,
  GENERIC_WINDOWS_FIXTURE.path,
  'C:/Users/Alice/other private/secret.txt',
  'D:/a/repo/external private/secret.txt',
  '//server/forward shared folder/secret file.txt',
  '//?/C:/Program Files/Forward Corp/secret file.txt',
  '//?/UNC/server/forward shared folder/secret file.txt',
  String.raw`\\?\C:\Program Files\O'Neil Corp\token file.txt`,
  String.raw`\\?\UNC\server\O'Neil shared folder\secret file.txt`,
  String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\Users\Alice\volume private\secret file.txt`,
  String.raw`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\Users\Alice\shadow private\secret file.txt`,
  '//?/Volume{12345678-1234-1234-1234-123456789abc}/Users/Alice/forward volume private/secret file.txt',
  String.raw`\\?/GLOBALROOT\Device/HarddiskVolumeShadowCopy2\Users/Alice/mixed shadow private/secret file.txt`,
  String.raw`\\.\O'Neil Device Name\secret file.txt`,
  String.raw`\\server\O'Neil shared folder\secret file.txt`,
];

const WINDOWS_LEAK_MARKERS = /O'Neil|Neil Smith|private docs|current private|other private|external private|forward shared folder|Forward Corp|Program Files|shared folder|volume private|shadow private|forward volume private|mixed shadow private|Volume\{|GLOBALROOT|HarddiskVolumeShadowCopy|Device Name|secret file/;
const NATIVE_WINDOWS_DIAGNOSTICS = WINDOWS_PATHS.map(
  (value) => `ENOENT: no such file or directory, open '${value}'`,
);
const PERSISTED_EDGE_HOME = String.raw`C:\Users\runneradmin`;
const PERSISTED_EDGE_VALUES = [
  String.raw`C:\Users\runneradministrator\private docs\artifact.json`,
  String.raw`\\?\C:\Users\runneradmin\current-safe\artifact.json`,
  String.raw`D:\Users\Alice\private\artifact.json`,
  String.raw`D:\repo\api_key=abcdefghijklmnop\artifact.json`,
  String.raw`D:\a\repo Ω\artifact.json`,
].map((value) => redactPersistedPath(value, {
  homeDir: PERSISTED_EDGE_HOME,
  platform: 'win32',
}));

function pathContexts(value) {
  const yamlSingleQuoted = `'${value.replaceAll("'", "''")}'`;
  return [
    value,
    `"${value}"`,
    yamlSingleQuoted,
    `windows_path: ${yamlSingleQuoted}\nnormal_marker: readable-text`,
    `windows_path=${value} | status=failed`,
    `ENOENT: no such file or directory, open '${value}'`,
    `before ${value} after`,
  ];
}

test('generic Windows fixture remains foreign when its first profile candidate is the current HOME', () => {
  const collisionHome = 'c:\\users\\deepmemoryfixturea\\';
  const fixture = foreignWindowsFixture(collisionHome);
  assert.equal(fixture.user, 'DeepMemoryFixtureB');
  assert.notEqual(
    path.win32.normalize(fixture.home).toLowerCase(),
    path.win32.normalize(collisionHome).replace(/\\+$/, '').toLowerCase(),
  );
  const redacted = redactString(fixture.path, {
    homeDir: collisionHome,
    platform: 'win32',
  });
  assert.match(redacted, new RegExp(REDACT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('redactString removes apostrophe-bearing spaced Windows paths in every structured text context', () => {
  for (const value of WINDOWS_PATHS) {
    for (const sample of pathContexts(value)) {
      const redacted = redactString(sample);
      assert.doesNotMatch(redacted, WINDOWS_LEAK_MARKERS, sample);
      assert.match(redacted, new RegExp(REDACT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(
      redactString(`ENOENT: no such file or directory, open '${value}'`),
      `ENOENT: no such file or directory, open '${REDACT_TAG}'`,
    );
    assert.equal(
      redactString(`windows_path: '${value.replaceAll("'", "''")}'\nnormal_marker: readable-text`),
      `windows_path: '${REDACT_TAG}'\nnormal_marker: readable-text`,
    );
    assert.equal(
      redactString(`windows_path=${value} | status=failed`),
      `windows_path=${REDACT_TAG} | status=failed`,
    );
  }
  for (const value of [
    String.raw`C:notes\todo.txt`,
    'C:notes/todo.txt',
    String.raw`ordinary\backslash\text`,
    String.raw`ordinary\O'Neil\backslash text`,
    "owner O'Neil wrote ordinary prose",
    'https://server.example/share/resource',
    'deep-memory://cards-stats',
  ]) {
    assert.equal(redactString(value), value);
  }
});

test('every advertised resource crosses the shared Windows path redaction boundary', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-resource-redaction-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const workspaceRoot = path.join(fixture, 'workspace');
  const memoryRoot = path.join(fixture, 'memory');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  const configText = [
    'normal_marker: readable-text',
    ...WINDOWS_PATHS.flatMap((value, index) => [
      `windows_path_${index}_plain: ${value}`,
      `windows_path_${index}_double: "${value}"`,
      `windows_path_${index}_single: '${value.replaceAll("'", "''")}'`,
      `windows_path_${index}_diagnostic: ${value} | status=failed`,
      `windows_path_${index}_native: ${NATIVE_WINDOWS_DIAGNOSTICS[index]}`,
    ]),
    ...PERSISTED_EDGE_VALUES.map((value, index) => `persisted_edge_${index}: ${value}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), configText);

  for (const entry of ['scripts/mcp-server.cjs', 'dist/mcp-server.cjs']) {
    const session = openMcpSession(process.execPath, [path.join(root, entry)], {
      cwd: root,
      env: {
        ...process.env,
        PLUGIN_ROOT: root,
        PROJECT_CWD: workspaceRoot,
        DEEP_MEMORY_ROOT: memoryRoot,
      },
    });
    t.after(() => session.close());
    try {
      await session.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'resource-redaction', version: '1' },
      });
      session.notify('notifications/initialized');
      const listed = await session.request('resources/list');
      assert.deepEqual(listed.result.resources.map(({ uri }) => uri).sort(), [
        'deep-memory://cards-stats',
        'deep-memory://config',
        'deep-memory://status',
      ], entry);
      let configResponse = '';
      for (const { uri } of listed.result.resources) {
        const read = await session.request('resources/read', { uri });
        const text = read.result.contents.map((item) => item.text).join('\n');
        for (const raw of WINDOWS_PATHS) assert.equal(text.includes(raw), false, `${entry} ${uri}: ${raw}`);
        assert.doesNotMatch(text, WINDOWS_LEAK_MARKERS, `${entry} ${uri}`);
        if (uri === 'deep-memory://config') configResponse = text;
      }
      assert.match(configResponse, /readable-text/, entry);
      assert.match(configResponse, /\[REDACTED\]/, entry);
      assert.match(configResponse, /~\\current-safe\\artifact\.json/, entry);
      assert.doesNotMatch(configResponse,
        /runneradministrator|D:\\Users\\Alice|api_key=abcdefghijklmnop|D:\\a\\repo Ω|\\\\\?\\/,
        `${entry} persisted provenance edge leaked through the MCP resource boundary`);
      assert.deepEqual(session.protocolErrors, [], entry);
    } finally {
      await session.close();
    }
  }
});

test('source and bundle do not let an extended current HOME destroy resource path recognition', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-resource-current-home-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const workspaceRoot = path.join(fixture, 'workspace');
  const memoryRoot = path.join(fixture, 'memory');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  const paths = [
    '//?/C:/Users/runneradmin/private docs/secret.txt',
    String.raw`\\?/C:/Users/runneradmin/private docs/secret.txt`,
    String.raw`//?\C:\Users\runneradmin\private docs\secret.txt`,
  ];
  fs.writeFileSync(path.join(memoryRoot, 'config.yaml'),
    paths.map((value, index) => `edge_${index}: ${value}`).join('\n'));

  for (const entry of ['scripts/mcp-server.cjs', 'dist/mcp-server.cjs']) {
    const session = openMcpSession(process.execPath, [path.join(root, entry)], {
      cwd: root,
      env: {
        ...process.env,
        HOME: 'C:/Users/runneradmin',
        USERPROFILE: 'C:\\Users\\runneradmin',
        PLUGIN_ROOT: root,
        PROJECT_CWD: workspaceRoot,
        DEEP_MEMORY_ROOT: memoryRoot,
      },
    });
    try {
      await session.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'resource-current-home', version: '1' },
      });
      session.notify('notifications/initialized');
      const read = await session.request('resources/read', { uri: 'deep-memory://config' });
      const text = read.result.contents.map((item) => item.text).join('\n');
      for (const raw of paths) assert.equal(text.includes(raw), false, `${entry}: ${raw}`);
      assert.doesNotMatch(text, /(?:[\\/]{2,}\?[\\/]+~|C:[\\/]Users[\\/]runneradmin)/i, entry);
      assert.deepEqual(session.protocolErrors, [], entry);
    } finally {
      await session.close();
    }
  }
});
