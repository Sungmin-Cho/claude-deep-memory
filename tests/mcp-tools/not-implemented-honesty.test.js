'use strict';
// Honesty regression: autonomous MCP tools that are not wired in v0.3.x must
// return `isError: true` with error='not_implemented' — NOT a fake success.
// Pre-fix deep_memory_save returned {status:'accepted'} (writing no card) and
// harvest/sessions/profile/audit(check) returned {status:'stub'|'ok'}, which
// made the model believe the operation succeeded.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function callMcpTool(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-honesty-'));
    const child = spawn('node', ['scripts/mcp-server.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const init = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    };
    const initNotif = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } };
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stdin.write(JSON.stringify(initNotif) + '\n');
    child.stdin.write(JSON.stringify(call) + '\n');

    setTimeout(() => {
      child.kill('SIGTERM');
      const lines = stdout.split('\n').filter(Boolean);
      let result = null;
      for (const line of lines) {
        try { const obj = JSON.parse(line); if (obj.id === 2) { result = obj; break; } } catch {}
      }
      // Surface any audit-log entries the server wrote (used to prove save
      // writes NOTHING now). Entries live at <root>/audit-log/<YYYY-MM>.jsonl.
      let auditLines = [];
      const auditDir = path.join(tmpRoot, 'audit-log');
      if (fs.existsSync(auditDir)) {
        for (const f of fs.readdirSync(auditDir)) {
          if (!f.endsWith('.jsonl')) continue;
          auditLines.push(...fs.readFileSync(path.join(auditDir, f), 'utf8').split('\n').filter(Boolean));
        }
      }
      if (!result) {
        reject(new Error(`No tools/call response. stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ result: result.result, auditLines });
    }, 1500);
  });
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
