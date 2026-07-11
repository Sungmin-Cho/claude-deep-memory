'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('Codex MCP config is plugin-relative and needs no env interpolation', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  const server = cfg.mcpServers['deep-memory'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['./dist/mcp-server.cjs']);
  assert.equal(server.cwd, '.');
  assert.doesNotMatch(JSON.stringify(server), /CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT/);
});

test('Codex manifest relies on default hook discovery accepted by validator', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
});

test('CJS bundle contract excludes import.meta and is pinned conversion-free', () => {
  const bundle = fs.readFileSync(path.join(root, 'dist/mcp-server.cjs'), 'utf8');
  assert.doesNotMatch(bundle, /import\.meta/);
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^dist\/mcp-server\.cjs -text\s*$/m);
});
