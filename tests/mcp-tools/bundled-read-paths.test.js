'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const { openMcpSession } = require('../helpers/mcp-session');
const { writeValidProjectProfile } = require('../helpers/project-profile-fixtures');

const root = path.resolve(__dirname, '../..');

function makeHookEvent(projectId) {
  const at = '2026-07-11T12:00:00.000Z';
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '1.0.2',
      artifact_kind: 'memory-hook-event',
      run_id: '01J0XKMRWQ7B9YZ8AE6F3VHTN5',
      generated_at: at,
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'host-stdin://codex/PostToolUse' }] },
      host: 'codex',
      session_id: 'artifact-only-session',
      project_id: projectId,
    },
    payload: {
      source_kind: 'hook-post-tool-use',
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: at,
      tool_name: 'apply_patch',
      tool_input_summary: 'artifact only fixture',
      tool_output_summary: 'fixture complete',
      raw_chars_in: 10,
      raw_chars_out: 10,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] },
    },
  };
}

async function pollGateViolation(memoryRoot) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const dir = path.join(memoryRoot, 'audit-log');
    if (fs.existsSync(dir)) {
      const lines = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean));
      if (lines.some((line) => JSON.parse(line).kind === 'gate-violation')) return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

test('artifact-only bundle reads embedded schemas, honest resources, and gate audit without node_modules', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-task2-artifact Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const pluginRoot = path.join(fixture, 'plugin only Ω');
  const workspaceRoot = path.join(fixture, 'workspace root Ω');
  const memoryRoot = path.join(fixture, 'memory root Ω');
  fs.mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  for (const relative of ['.mcp.json', 'package.json']) {
    fs.copyFileSync(path.join(root, relative), path.join(pluginRoot, relative));
  }
  fs.copyFileSync(path.join(root, 'dist/mcp-server.cjs'), path.join(pluginRoot, 'dist/mcp-server.cjs'));
  assert.equal(fs.existsSync(path.join(pluginRoot, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'schemas')), false);

  const profile = writeValidProjectProfile(workspaceRoot);
  const hookEvent = makeHookEvent(profile.project_id);
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/memory-hook-event.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(hookEvent), true, JSON.stringify(validate.errors));
  const eventDir = path.join(memoryRoot, 'events');
  fs.mkdirSync(eventDir, { recursive: true });
  fs.writeFileSync(path.join(eventDir, '2026-07.jsonl'), `${JSON.stringify(hookEvent)}\n`);
  fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), 'capture:\n  enabled: false\nfixture_marker: artifact-readable\n');

  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const server = config.mcpServers['deep-memory'];
  const session = openMcpSession(server.command, server.args, {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
    },
    timeoutMs: 10000,
  });
  t.after(() => session.close());

  const init = await session.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'artifact-only-test', version: '1' },
  });
  assert.equal(init.result.serverInfo.name, 'deep-memory');
  session.notify('notifications/initialized', {});
  assert.equal(session.initializedWritten, true);

  const recall = await session.request('tools/call', {
    name: 'deep_memory_recall',
    arguments: { query: 'missing index is still a valid read', limit: 5, project_scope: 'current' },
  });
  assert.equal(recall.result.isError, undefined);
  assert.doesNotMatch(recall.result.content[0].text, /ENOENT|schemas|retrieval_failed/);

  const listed = await session.request('resources/list', {});
  assert.deepEqual(listed.result.resources.map((item) => item.uri).sort(), [
    'deep-memory://cards-stats',
    'deep-memory://config',
    'deep-memory://status',
  ]);
  for (const { uri } of listed.result.resources) {
    const resource = await session.request('resources/read', { uri });
    assert.equal(resource.result.contents[0].uri, uri);
    assert.notEqual(resource.result.contents[0].text, '{}', uri);
  }

  const denied = await session.request('tools/call', {
    name: 'deep_memory_forget',
    arguments: { memory_id: 'mem_denied' },
  });
  assert.equal(denied.result.isError, true);
  const auditLines = await pollGateViolation(memoryRoot);
  assert.equal(auditLines.filter((line) => JSON.parse(line).kind === 'gate-violation').length, 1);
  assert.deepEqual(session.protocolErrors, []);
  assert.equal(session.stderr, '');
});
