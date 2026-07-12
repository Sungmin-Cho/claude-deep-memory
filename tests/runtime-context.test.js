'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectHost } = require('../scripts/lib/runtime-context');

test('Codex wins before its Claude compatibility marker', () => {
  assert.equal(detectHost({
    PLUGIN_ROOT: 'C:\\Program Files\\Codex Plugins\\deep-memory',
    CLAUDE_PLUGIN_ROOT: 'C:\\Program Files\\Codex Plugins\\deep-memory',
  }), 'codex');
});

test('Claude-only marker remains Claude Code', () => {
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: '/plugins/deep-memory' }), 'claude-code');
});

test('unknown host does not probe the shell', () => {
  assert.equal(detectHost({ PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' }), '(other)');
});

test('host detection retains supported compatibility markers', () => {
  assert.equal(detectHost({ CURSOR_PLUGIN_ROOT: '/plugins/deep-memory' }), 'cursor');
  assert.equal(detectHost({ GEMINI_CLI_ROOT: '/plugins/deep-memory' }), 'gemini-cli');
  assert.equal(detectHost({ CLINE_PLUGIN_ROOT: '/plugins/deep-memory' }), 'cline');
});

test('hook common delegates an injected environment to the pure detector', async () => {
  const common = await import('../scripts/hooks/common.mjs');
  assert.equal(common.detectHost({
    PLUGIN_ROOT: 'C:\\Codex Plugins\\deep-memory',
    CLAUDE_PLUGIN_ROOT: 'C:\\Codex Plugins\\deep-memory',
  }), 'codex');
  assert.equal(common.detectHost({ CLAUDE_PLUGIN_ROOT: '/claude/deep-memory' }), 'claude-code');
});
