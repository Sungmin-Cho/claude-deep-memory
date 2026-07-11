'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('../helpers/mcp-session');

const root = path.resolve(__dirname, '../..');

test('committed bundle initializes from plugin cwd and survives initialized notification', async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bundle-Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const pluginRoot = path.join(fixture, 'plugin root Ω');
  const workspaceRoot = path.join(fixture, 'workspace root Ω');
  const memoryRoot = path.join(fixture, 'memory root Ω');
  fs.mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.copyFileSync(path.join(root, 'dist', 'mcp-server.cjs'), path.join(pluginRoot, 'dist', 'mcp-server.cjs'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pluginRoot, 'package.json'));

  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  const server = cfg.mcpServers['deep-memory'];
  const session = openMcpSession(server.command, server.args, {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_ROOT: pluginRoot,
      PROJECT_CWD: workspaceRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
    },
  });
  t.after(() => session.close());

  const initialized = await session.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'deep-memory-task1-smoke', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'deep-memory');
  session.notify('notifications/initialized', {});
  assert.equal(session.initializedWritten, true);
  const listed = await session.request('tools/list', {});
  assert.ok(Array.isArray(listed.result.tools));
  assert.equal(session.child.exitCode, null);
  assert.deepEqual(session.protocolErrors, []);
});
