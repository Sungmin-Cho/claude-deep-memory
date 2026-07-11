'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactString, REDACT_TAG } = require('../../scripts/lib/redact');
const { openMcpSession } = require('../helpers/mcp-session');

const root = path.resolve(__dirname, '../..');
const WINDOWS_PATHS = [
  String.raw`C:\Users\Alice\secret.txt`,
  String.raw`\\?\C:\Users\Alice\secret.txt`,
  String.raw`\\?\UNC\server\share\secret.txt`,
  String.raw`\\.\PhysicalDrive0`,
  String.raw`\\server\share\secret.txt`,
];

test('redactString removes complete Windows absolute path forms without matching relative text', () => {
  for (const value of WINDOWS_PATHS) {
    const redacted = redactString(`before ${value} after`);
    assert.doesNotMatch(redacted, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(redacted, new RegExp(REDACT_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(redacted, /^before /);
    assert.match(redacted, / after$/);
  }
  for (const value of [
    String.raw`C:notes\todo.txt`,
    String.raw`ordinary\backslash\text`,
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
    ...WINDOWS_PATHS.map((value, index) => `windows_path_${index}: ${value}`),
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
      if (uri === 'deep-memory://config') configResponse = text;
    }
    assert.match(configResponse, /readable-text/, entry);
    assert.match(configResponse, /\[REDACTED\]/, entry);
    assert.deepEqual(session.protocolErrors, [], entry);
    await session.close();
  }
});
