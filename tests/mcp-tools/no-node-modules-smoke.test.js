'use strict';
// Regression: marketplace/cache installs may not run npm ci. The MCP server
// entrypoint used by manifests must still handshake and list tools when the
// plugin artifact has no node_modules directory.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function listToolsFromIsolatedDist() {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-dist-'));
    const pluginRoot = path.join(tmp, 'plugin');
    const distDir = path.join(pluginRoot, 'dist');
    const memoryRoot = path.join(tmp, 'memory-root');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(memoryRoot, { recursive: true });
    fs.copyFileSync(
      path.join(root, 'dist/mcp-server.cjs'),
      path.join(distDir, 'mcp-server.cjs'),
    );
    fs.copyFileSync(
      path.join(root, 'package.json'),
      path.join(pluginRoot, 'package.json'),
    );

    assert.ok(!fs.existsSync(path.join(pluginRoot, 'node_modules')),
      'test fixture must not include node_modules');

    const child = spawn('node', ['dist/mcp-server.cjs'], {
      cwd: pluginRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEP_MEMORY_ROOT: memoryRoot },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);

    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'no-node-modules-smoke', version: '0' },
      },
    };
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stdin.write(JSON.stringify(initialized) + '\n');
    child.stdin.write(JSON.stringify(list) + '\n');

    setTimeout(() => {
      child.kill('SIGTERM');
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.id === 2) {
            resolve(obj);
            return;
          }
        } catch {}
      }
      reject(new Error(`tools/list response not found. stdout=${stdout.slice(0, 800)} stderr=${stderr.slice(0, 800)}`));
    }, 1500);
  });
}

test('MCP dist entrypoint handshakes without node_modules', async () => {
  const resp = await listToolsFromIsolatedDist();
  assert.ok(resp.result && Array.isArray(resp.result.tools), `unexpected response: ${JSON.stringify(resp)}`);
  assert.strictEqual(resp.result.tools.length, 10);
  const names = new Set(resp.result.tools.map((tool) => tool.name));
  assert.ok(names.has('deep_memory_brief'));
  assert.ok(names.has('deep_memory_recall'));
  assert.ok(names.has('deep_memory_export'));
});
