'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { openMcpSession } = require('./helpers/mcp-session');

const root = path.resolve(__dirname, '..');

test('MCP server closes itself promptly when the host closes stdin', async (t) => {
  const session = openMcpSession(process.execPath, [path.join(root, 'scripts/mcp-server.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      PLUGIN_ROOT: root,
      PROJECT_CWD: root,
      DEEP_MEMORY_ROOT: path.join(root, '.deep-memory-test-eof-unused'),
    },
  });
  t.after(() => session.close(50));

  await session.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'eof-lifecycle', version: '1' },
  });
  session.notify('notifications/initialized');

  session.child.stdin.end();
  let timer;
  const outcome = await Promise.race([
    new Promise((resolve) => session.child.once('close', () => resolve('closed'))),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 750); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'closed', 'stdio MCP lifecycle must not require an external force kill');
});
