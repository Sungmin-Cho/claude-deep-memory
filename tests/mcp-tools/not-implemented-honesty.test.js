'use strict';
// Honesty regression: autonomous MCP tools that are not wired in v0.3.x must
// return `isError: true` with error='not_implemented' — NOT a fake success.
// Pre-fix deep_memory_save returned {status:'accepted'} (writing no card) and
// harvest/sessions/profile/audit(check) returned {status:'stub'|'ok'}, which
// made the model believe the operation succeeded.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('../helpers/mcp-session');

const ROOT = path.resolve(__dirname, '../..');

async function closeConfirmed(session) {
  await session.close();
  assert.ok(session.child.exitCode !== null || session.child.signalCode !== null,
    'MCP child close must be confirmed');
  for (const stream of [session.child.stdin, session.child.stdout, session.child.stderr]) {
    assert.strictEqual(stream.destroyed, true, 'every MCP protocol stream must be destroyed');
  }
}

async function callMcpTool(toolName, args = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-honesty-'));
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
    // Surface any audit-log entries the server wrote (used to prove save
    // writes NOTHING now). Entries live at <root>/audit-log/<YYYY-MM>.jsonl.
    const auditLines = [];
    const auditDir = path.join(tmpRoot, 'audit-log');
    if (fs.existsSync(auditDir)) {
      for (const file of fs.readdirSync(auditDir)) {
        if (!file.endsWith('.jsonl')) continue;
        auditLines.push(...fs.readFileSync(path.join(auditDir, file), 'utf8').split('\n').filter(Boolean));
      }
    }
    assert.deepStrictEqual(session.protocolErrors, []);
    return { result: response.result, auditLines };
  } finally {
    try { await closeConfirmed(session); }
    finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }
}

const NOT_IMPLEMENTED = [
  { name: 'deep_memory_save', args: { memory_type: 'pattern', title: 't', claim: 'c' } },
  { name: 'deep_memory_harvest', args: { source: 'siblings' } },
  { name: 'deep_memory_sessions', args: {} },
  { name: 'deep_memory_profile', args: { action: 'show' } },
  { name: 'deep_memory_audit', args: { mode: 'check' } }
];

for (const c of NOT_IMPLEMENTED) {
  const label = c.args.mode ? `${c.name}(mode=${c.args.mode})` : c.name;
  test(`honesty: ${label} returns isError not_implemented (no fake success)`, async () => {
    const { result } = await callMcpTool(c.name, c.args);
    assert.ok(result, 'expected a result object');
    assert.strictEqual(result.isError, true, `${label} must report isError`);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.error, 'not_implemented', `${label} error should be not_implemented`);
    // Must never masquerade as accepted/ok/stub success.
    assert.notStrictEqual(parsed.status, 'accepted');
    assert.notStrictEqual(parsed.status, 'ok');
    assert.notStrictEqual(parsed.status, 'stub');
  });
}

test('honesty: deep_memory_save writes NO audit-log entry (nothing was saved)', async () => {
  const { auditLines } = await callMcpTool('deep_memory_save', { memory_type: 'pattern', title: 't', claim: 'c' });
  const saveEntries = auditLines.filter((l) => {
    try { return JSON.parse(l)?.kind === 'save'; } catch { return false; }
  });
  assert.strictEqual(saveEntries.length, 0, `save must not write a 'save' audit entry; got ${JSON.stringify(saveEntries)}`);
});
