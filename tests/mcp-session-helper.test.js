'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openMcpSession } = require('./helpers/mcp-session');

test('MCP session close proves the child and protocol pipes are closed before it resolves', async (t) => {
  const code = [
    "process.on('SIGTERM', () => {})",
    'process.stdin.resume()',
    'setInterval(() => {}, 1000)',
  ].join(';');
  const session = openMcpSession(process.execPath, ['-e', code], {
    cwd: process.cwd(),
  });
  t.after(() => {
    if (session.child.exitCode === null) session.child.kill('SIGKILL');
  });

  await session.close(50);

  assert.ok(
    session.child.exitCode !== null || session.child.signalCode !== null,
    'close must await a confirmed child exit',
  );
  assert.equal(session.child.stdout.destroyed, true);
  assert.equal(session.child.stderr.destroyed, true);
});

test('every MCP tool fixture routes piped server children through the confirmed-close helper', () => {
  const directory = path.join(__dirname, 'mcp-tools');
  const offenders = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      return /\bspawn\s*\(/.test(source) && /mcp-server\.(?:mjs|cjs)/.test(source);
    })
    .sort();
  assert.deepEqual(offenders, [], `direct MCP pipe lifecycle bypasses: ${offenders.join(', ')}`);
});
