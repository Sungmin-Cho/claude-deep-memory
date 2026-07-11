'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectHost } = require('../scripts/lib/runtime-context');

test('Codex PLUGIN_ROOT wins over compatibility CLAUDE_PLUGIN_ROOT', () => {
  assert.equal(detectHost({
    PLUGIN_ROOT: '/cache/claude-deep-memory',
    CLAUDE_PLUGIN_ROOT: '/cache/claude-deep-memory',
  }), 'codex');
});

test('host detection covers Claude and supported compatibility hosts without CODEX_PLUGIN_ROOT', () => {
  assert.equal(detectHost({ CLAUDE_PLUGIN_ROOT: '/plugins/deep-memory' }), 'claude-code');
  assert.equal(detectHost({ CURSOR_PLUGIN_ROOT: '/plugins/deep-memory' }), 'cursor');
  assert.equal(detectHost({ GEMINI_CLI_ROOT: '/plugins/deep-memory' }), 'gemini-cli');
  assert.equal(detectHost({ CLINE_PLUGIN_ROOT: '/plugins/deep-memory' }), 'cline');
  assert.equal(detectHost({}), '(other)');
});
