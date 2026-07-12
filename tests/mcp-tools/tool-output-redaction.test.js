'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openIndex, upsertCard, closeIndex } = require('../../scripts/lib/fts-index');
const { v2LexicalIndexPath } = require('../../scripts/lib/v2-index-paths');
const { redactMcpPayload } = require('../../scripts/lib/mcp-output-redaction');
const { openMcpSession } = require('../helpers/mcp-session');
const { writeValidProjectProfile } = require('../helpers/project-profile-fixtures');
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
const RAW_SENSITIVE = [
  '/Users/Alice/private/secret.txt',
  ...WINDOWS_PATHS,
  'api_key=abcdefghijklmnop',
  'token: abcdefghijklmnop',
  'Bearer abcdefghijklmnop',
];
const LEAK_TEXT = RAW_SENSITIVE.join(' | ');
const NATIVE_WINDOWS_DIAGNOSTICS = WINDOWS_PATHS.map(
  (value) => `ENOENT: no such file or directory, open '${value}'`,
);
const NATIVE_DIAGNOSTIC_TEXT = NATIVE_WINDOWS_DIAGNOSTICS.join(' | ');

function nodeOptionsRequireSpec(preload, { platform = process.platform } = {}) {
  let value = String(preload);
  if (platform === 'win32') value = value.replaceAll('\\', '/');
  if (/["\r\n]/.test(value)) throw new Error('unsafe_preload_path');
  return `--require="${value}"`;
}

function throwingFsPreloadSource({
  separator = path.sep,
  diagnostic = NATIVE_DIAGNOSTIC_TEXT,
} = {}) {
  const needle = ['indexes', 'v2', 'lexical.sqlite'].join(separator);
  return `'use strict';\nconst fs = require('node:fs');\nconst original = fs.existsSync;\nfs.existsSync = function (value) {\n  if (String(value).includes(${JSON.stringify(needle)})) {\n    throw new Error(${JSON.stringify(`native search failed ${diagnostic}`)});\n  }\n  return original.call(this, value);\n};\n`;
}

function fixture(t, prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return fs.realpathSync.native(value);
}

function wrappedCard(memoryId, projectId, claim) {
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '1.0.2',
      artifact_kind: 'memory-card',
      run_id: `run-${memoryId}`,
      generated_at: '2026-07-11T12:00:00.000Z',
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: 'fixture/task2.json' }], tool_versions: {} },
    },
    payload: {
      memory_id: memoryId,
      memory_type: 'failure-case',
      privacy_level: 'local',
      claim,
      tags: ['safe-marker', LEAK_TEXT],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: ['safe', 'marker'],
      evidence_summary: ['task2 fixture'],
      confidence: 0.9,
      status: 'candidate',
      dedupe_key: `sha256:${Buffer.from(memoryId).toString('hex').padEnd(64, '0').slice(0, 64)}`,
    },
  };
}

function plantIndexed(memoryRoot, projectId, card, { malformed = false } = {}) {
  const cardPath = path.join(memoryRoot, 'cards', card.payload.memory_type, projectId, `${card.payload.memory_id}.json`);
  fs.mkdirSync(path.dirname(cardPath), { recursive: true });
  fs.writeFileSync(cardPath, malformed ? '{' : JSON.stringify(card));
  const db = openIndex(v2LexicalIndexPath(memoryRoot));
  try { upsertCard(db, card, { projectId }); }
  finally { closeIndex(db); }
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allStrings(item, out));
  return out;
}

function assertNoLeaks(value, label) {
  const strings = allStrings(value);
  for (const text of strings) {
    for (const raw of RAW_SENSITIVE) assert.equal(text.includes(raw), false, `${label}: leaked ${raw}`);
    assert.doesNotMatch(text,
      /O'Neil|Neil Smith|private docs|current private|other private|external private|forward shared folder|Forward Corp|Program Files|shared folder|volume private|shadow private|forward volume private|mixed shadow private|Volume\{|GLOBALROOT|HarddiskVolumeShadowCopy|Device Name|secret file/,
      `${label}: leaked a Windows path suffix`);
  }
}

test('shared output boundary recursively redacts structured MCP fields', () => {
  const pathContexts = WINDOWS_PATHS.flatMap((value) => [
    value,
    `"${value}"`,
    `'${value.replaceAll("'", "''")}'`,
    `windows_path: '${value.replaceAll("'", "''")}'`,
    `windows_path=${value} | status=failed`,
    `ENOENT: no such file or directory, open '${value}'`,
  ]);
  const result = redactMcpPayload({
    structuredContent: {
      nested: [{ diagnostic: LEAK_TEXT, pathContexts }],
    },
    content: [{ type: 'text', text: `safe marker ${LEAK_TEXT}` }],
  });
  assertNoLeaks(result, 'structured content');
  assert.match(result.structuredContent.nested[0].diagnostic, /\[REDACTED\]/);
  assert.match(result.content[0].text, /safe marker/);
});

async function start(t, workspaceRoot, memoryRoot, extraEnv = {}, entry = 'scripts/mcp-server.cjs') {
  const session = openMcpSession(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env: {
      ...process.env,
      PLUGIN_ROOT: root,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
      ...extraEnv,
    },
    timeoutMs: 10000,
  });
  t.after(() => session.close());
  await session.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-redaction', version: '1' },
  });
  session.notify('notifications/initialized');
  return session;
}

test('every advertised tool success and failure result is redacted at the real stdio boundary', async (t) => {
  const workspaceRoot = fixture(t, 'dm-tool-redaction-workspace-');
  const memoryRoot = fixture(t, 'dm-tool-redaction-memory-');
  const profile = writeValidProjectProfile(workspaceRoot);
  plantIndexed(
    memoryRoot,
    profile.project_id,
    wrappedCard('mem_task2_visible', profile.project_id, `safe marker visible claim ${LEAK_TEXT}`),
  );
  plantIndexed(
    memoryRoot,
    profile.project_id,
    wrappedCard('mem_task2_malformed', profile.project_id, `safe marker malformed ${LEAK_TEXT}`),
    { malformed: true },
  );

  const calls = {
    deep_memory_brief: { task: 'safe marker', limit: 5 },
    deep_memory_smart_search: { query: 'safe marker', limit: 5 },
    deep_memory_recall: { query: 'safe marker', limit: 5 },
    deep_memory_save: { memory_type: 'pattern', title: 'safe-marker', claim: LEAK_TEXT },
    deep_memory_harvest: { source: LEAK_TEXT },
    deep_memory_audit: { mode: 'check' },
    deep_memory_forget: { memory_id: LEAK_TEXT },
    deep_memory_sessions: { limit: 5 },
    deep_memory_profile: { action: 'show' },
    deep_memory_export: { scope: 'all', target_path: LEAK_TEXT },
  };
  for (const entry of ['scripts/mcp-server.cjs', 'dist/mcp-server.cjs']) {
    const session = await start(t, workspaceRoot, memoryRoot, {}, entry);
    try {
      const listed = await session.request('tools/list');
      const toolNames = listed.result.tools.map(({ name }) => name).sort();
      assert.equal(toolNames.length, 10, entry);
      const responses = {};
      for (const name of toolNames) {
        responses[name] = await session.request('tools/call', { name, arguments: calls[name] });
        assertNoLeaks(responses[name], `${entry} ${name}`);
      }
      const recallText = responses.deep_memory_recall.result.content.map(({ text }) => text).join('\n');
      assert.match(recallText, /safe marker visible claim/, entry);
      assert.match(recallText, /\[REDACTED\]/, entry);
      assert.match(recallText, /card_filter_dropped/, entry);
      assert.equal(responses.deep_memory_forget.result.isError, true, entry);
      assert.equal(responses.deep_memory_export.result.isError, true, entry);

      const invalid = await session.request('tools/call', {
        name: 'deep_memory_save', arguments: { memory_type: 'pattern' },
      });
      assert.equal(invalid.result.isError, true, entry);
      assert.match(invalid.result.content[0].text, /invalid_tool_arguments/, entry);
      assertNoLeaks(invalid, `${entry} validation rejection`);

      const unknown = await session.request('tools/call', {
        name: `deep_memory_unknown ${LEAK_TEXT}`,
        arguments: { raw: LEAK_TEXT },
      });
      assert.equal(unknown.result.isError, true, entry);
      assert.match(unknown.result.content[0].text, /unknown_tool/, entry);
      assertNoLeaks(unknown, `${entry} unknown tool`);

      const nativeUnknown = await session.request('tools/call', {
        name: `deep_memory_unknown ${NATIVE_DIAGNOSTIC_TEXT}`,
        arguments: { raw: NATIVE_DIAGNOSTIC_TEXT },
      });
      assert.equal(nativeUnknown.result.isError, true, entry);
      assert.match(nativeUnknown.result.content[0].text, /unknown_tool/, entry);
      assertNoLeaks(nativeUnknown, `${entry} native diagnostic unknown tool`);
      assert.deepEqual(session.protocolErrors, [], entry);
    } finally {
      await session.close();
    }
  }
});

test('source and bundle do not let an extended current HOME bypass tool and error redaction', async (t) => {
  const workspaceRoot = fixture(t, 'dm-tool-current-home-workspace-');
  const memoryRoot = fixture(t, 'dm-tool-current-home-memory-');
  const paths = [
    '//?/C:/Users/runneradmin/private docs/secret.txt',
    String.raw`\\?/C:/Users/runneradmin/private docs/secret.txt`,
    String.raw`//?\C:\Users\runneradmin\private docs\secret.txt`,
  ];
  for (const entry of ['scripts/mcp-server.cjs', 'dist/mcp-server.cjs']) {
    const session = await start(t, workspaceRoot, memoryRoot, {
      HOME: 'C:/Users/runneradmin',
      USERPROFILE: 'C:\\Users\\runneradmin',
    }, entry);
    try {
      for (const raw of paths) {
        const response = await session.request('tools/call', {
          name: `deep_memory_unknown ${raw}`,
          arguments: { raw },
        });
        assert.equal(response.result.isError, true, `${entry}: ${raw}`);
        const text = allStrings(response).join('\n');
        assert.equal(text.includes(raw), false, `${entry}: leaked ${raw}`);
        assert.doesNotMatch(text,
          /(?:[\\/]{2,}\?[\\/]+~|C:[\\/]Users[\\/]runneradmin)/i,
          `${entry}: malformed extended HOME token`);
      }
      assert.deepEqual(session.protocolErrors, [], entry);
    } finally {
      await session.close();
    }
  }
});

test('Windows caught-error preload option serializes a slash-stable absolute path', () => {
  const preload = String.raw`C:\Users\Runner Admin\memory Ω\throwing-fs-preload.cjs`;
  const option = nodeOptionsRequireSpec(preload, { platform: 'win32' });
  assert.equal(option, '--require="C:/Users/Runner Admin/memory Ω/throwing-fs-preload.cjs"');
});

test('Windows caught-error preload source escapes its separator needle', () => {
  const separator = '\\';
  const source = throwingFsPreloadSource({ separator, diagnostic: 'safe diagnostic' });
  const needle = ['indexes', 'v2', 'lexical.sqlite'].join(separator);
  assert.match(source, new RegExp(`includes\\(${JSON.stringify(JSON.stringify(needle)).slice(1, -1)}\\)`));
  assert.doesNotThrow(() => new Function(source));
});

test('caught native-search diagnostics containing paths and secrets are redacted on stdio', async (t) => {
  const workspaceRoot = fixture(t, 'dm-tool-error-workspace-');
  const memoryRoot = fixture(t, 'dm-tool-error-memory-');
  writeValidProjectProfile(workspaceRoot);
  const preload = path.join(memoryRoot, 'throwing-fs-preload.cjs');
  fs.writeFileSync(preload, throwingFsPreloadSource());
  const session = await start(t, workspaceRoot, memoryRoot, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${nodeOptionsRequireSpec(preload)}`.trim(),
  });
  try {
    const response = await session.request('tools/call', {
      name: 'deep_memory_recall', arguments: { query: 'safe marker', limit: 5 },
    });
    assert.equal(response.result.isError, undefined);
    assert.match(response.result.content[0].text, /fts_stream_error/);
    assert.match(response.result.content[0].text, /\[REDACTED\]/);
    assertNoLeaks(response, 'caught native error');
  } finally {
    await session.close();
  }
});

test('runtime has one CallTool wrapper and no direct tool transport bypass', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/lib/mcp-server-runtime.js'), 'utf8');
  assert.equal((source.match(/setRequestHandler\(CallToolRequestSchema/g) || []).length, 1);
  assert.equal((source.match(/redactMcpPayload\(/g) || []).length >= 2, true,
    'tool and resource handlers must share final redaction');
  assert.doesNotMatch(source, /process\.stdout\.(?:write|emit)|transport\.(?:send|write)/);
});
