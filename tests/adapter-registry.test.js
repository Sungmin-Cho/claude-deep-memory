const test = require('node:test');
const assert = require('node:assert');
const { detect } = require('../scripts/lib/adapter-registry');
const { adapterForHost } = require('../scripts/lib/runtime-context');
const { ADAPTER_NAMES } = require('../scripts/lib/llm-bridge');

test('adapter-registry.detect: explicit override returns input as-is', () => {
  assert.strictEqual(detect('claude-agent'), 'claude-agent');
  assert.strictEqual(detect('codex-bash'), 'codex-bash');
  assert.strictEqual(detect('stdin-fallback'), 'stdin-fallback');
});

test('adapter-registry.detect: auto maps an injected host env deterministically', () => {
  assert.strictEqual(detect('auto', {
    env: { PLUGIN_ROOT: '/codex', CLAUDE_PLUGIN_ROOT: '/compat' },
  }), 'codex-bash');
  assert.strictEqual(detect('auto', {
    env: { CLAUDE_PLUGIN_ROOT: '/claude' },
  }), 'claude-agent');
  assert.strictEqual(detect('auto', {
    env: { GEMINI_CLI_ROOT: '/gemini' },
  }), 'gemini-sdk');
  assert.strictEqual(detect('auto', { env: { PATH: '/does/not/matter' } }), 'stdin-fallback');
});

test('adapterForHost keeps unsupported compatibility hosts on stdin fallback', () => {
  assert.strictEqual(adapterForHost('claude-code'), 'claude-agent');
  assert.strictEqual(adapterForHost('codex'), 'codex-bash');
  assert.strictEqual(adapterForHost('gemini-cli'), 'gemini-sdk');
  assert.strictEqual(adapterForHost('cursor'), 'stdin-fallback');
  assert.strictEqual(adapterForHost('(other)'), 'stdin-fallback');
});

test('llm-bridge ADAPTER_NAMES is the allowlist (R3 P14)', () => {
  assert.deepStrictEqual(ADAPTER_NAMES, ['claude-agent', 'codex-bash', 'gemini-sdk', 'stdin-fallback']);
});
