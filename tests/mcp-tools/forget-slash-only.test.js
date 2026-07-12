'use strict';
// δ.20 R4-A — verify deep_memory_forget (and other 5 mutation tools) return
// slash_only_in_v030 error when called via the MCP autonomous tool surface.
// Spec §6.3.1 Gate 2 (R3-B option-a — no consent_token machinery; slash-only).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('../helpers/mcp-session');

const ROOT = path.resolve(__dirname, '../..');

// IMPL-R1-A — tool names aligned with spec §6.3 enumeration.
// Mutation calls now use unified `deep_memory_audit` with mode != 'check',
// `deep_memory_export` with scope='all', and `deep_memory_forget`.
const MUTATION_CALLS = [
  { name: 'deep_memory_forget',  args: { memory_id: 'mem_x', reason: 'test' } },
  { name: 'deep_memory_audit',   args: { mode: 'unlock' } },
  { name: 'deep_memory_audit',   args: { mode: 'promote', memory_id: 'mem_x' } },
  { name: 'deep_memory_audit',   args: { mode: 'rebuild-index' } },
  { name: 'deep_memory_audit',   args: { mode: 'rebuild-vectors' } },
  { name: 'deep_memory_export',  args: { scope: 'all', target_path: '/tmp/x.json' } }
];

async function closeConfirmed(session) {
  await session.close();
  assert.ok(session.child.exitCode !== null || session.child.signalCode !== null,
    'MCP child close must be confirmed');
  for (const stream of [session.child.stdin, session.child.stdout, session.child.stderr]) {
    assert.strictEqual(stream.destroyed, true, 'every MCP protocol stream must be destroyed');
  }
}

async function callMcpTool(toolName, args = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-'));
  const session = openMcpSession(process.execPath, [path.join(ROOT, 'scripts/mcp-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
  });
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
    });
    session.notify('notifications/initialized');
    const response = await session.request('tools/call', { name: toolName, arguments: args });
    assert.deepStrictEqual(session.protocolErrors, []);
    return response;
  } finally {
    try { await closeConfirmed(session); }
    finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }
}

for (const call of MUTATION_CALLS) {
  const label = call.args.mode ? `${call.name}(mode=${call.args.mode})`
              : call.args.scope ? `${call.name}(scope=${call.args.scope})`
              : call.name;
  test(`R4-A: ${label} returns slash_only_in_v030 (Gate 2/3)`, async () => {
    const resp = await callMcpTool(call.name, call.args);
    assert.ok(resp.result, `expected result, got: ${JSON.stringify(resp)}`);
    assert.strictEqual(resp.result.isError, true, `${label} should report isError`);
    const content = resp.result.content[0].text;
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.error, 'slash_only_in_v030',
      `${label} should return slash_only_in_v030; got: ${parsed.error}`);
  });
}

test('IMPL-R1-A: deep_memory_audit(mode=check) is autonomous-allowed', async () => {
  const resp = await callMcpTool('deep_memory_audit', { mode: 'check' });
  assert.ok(resp.result, `expected result, got: ${JSON.stringify(resp)}`);
  // mode=check should NOT trigger slash_only_in_v030
  if (resp.result.isError) {
    const content = JSON.parse(resp.result.content[0].text);
    assert.notStrictEqual(content.error, 'slash_only_in_v030',
      'audit mode=check should be autonomous-readable per Gate 2 carve-out');
  }
});

test('IMPL-R1-A: deep_memory_export(scope=current-project) is autonomous-allowed', async () => {
  const resp = await callMcpTool('deep_memory_export', { scope: 'current-project', target_path: '/tmp/y.json' });
  assert.ok(resp.result);
  // scope=current-project bypasses Gate 3 (only scope=all is gated)
  if (resp.result.isError) {
    const content = JSON.parse(resp.result.content[0].text);
    assert.notStrictEqual(content.error, 'slash_only_in_v030',
      'export scope=current-project should be autonomous-allowed');
  }
});

test('R4-F: deep_memory_save is NOT slash-blocked (additive + local, no consent gate)', async () => {
  const resp = await callMcpTool('deep_memory_save', {
    memory_type: 'pattern',
    title: 'test',
    claim: 'test claim'
  });
  assert.ok(resp.result, `expected result, got: ${JSON.stringify(resp)}`);
  // save returns stub OK or content — not isError + slash_only_in_v030
  if (resp.result.isError) {
    const content = JSON.parse(resp.result.content[0].text);
    assert.notStrictEqual(content.error, 'slash_only_in_v030',
      'save should NOT be slash-blocked per spec §6.3.1 Gate 2 carve-out');
  }
});

test('R4-F: tools/list exposes all 10 tools per spec §6.3 (IMPL-R1-A rename)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-list-'));
  const session = openMcpSession(process.execPath, [path.join(ROOT, 'scripts/mcp-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
  });
  try {
    await session.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' },
    });
    session.notify('notifications/initialized');
    const response = await session.request('tools/list');
    assert.strictEqual(response.result.tools.length, 10,
      `expected 10 tools, got ${response.result.tools.length}`);
    const names = new Set(response.result.tools.map((tool) => tool.name));
    assert.ok(names.has('deep_memory_recall'));
    assert.ok(names.has('deep_memory_forget'));
    assert.deepStrictEqual(session.protocolErrors, []);
  } finally {
    try { await closeConfirmed(session); }
    finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }
});
