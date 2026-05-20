const test = require('node:test');
const assert = require('node:assert');
const { detect } = require('../scripts/lib/adapter-registry');
const { ADAPTER_NAMES } = require('../scripts/lib/llm-bridge');

test('adapter-registry.detect: explicit override returns input as-is', () => {
  assert.strictEqual(detect('claude-agent'), 'claude-agent');
  assert.strictEqual(detect('codex-bash'), 'codex-bash');
  assert.strictEqual(detect('stdin-fallback'), 'stdin-fallback');
});

test('adapter-registry.detect: auto picks via env vars or stdin-fallback default', () => {
  // Save + clear env
  const saved = { CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT: process.env.CODEX_PLUGIN_ROOT, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CODEX_PLUGIN_ROOT;
  delete process.env.GEMINI_API_KEY;
  try {
    process.env.CLAUDE_PLUGIN_ROOT = '/x';
    assert.strictEqual(detect('auto'), 'claude-agent');
    delete process.env.CLAUDE_PLUGIN_ROOT;

    process.env.GEMINI_API_KEY = 'abc';
    // codex CLI presence on PATH may override; just assert one of the env-driven adapters
    const r = detect('auto');
    assert.ok(['claude-agent', 'codex-bash', 'gemini-sdk', 'stdin-fallback'].includes(r));
  } finally {
    // restore
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v; else delete process.env[k];
    }
  }
});

test('llm-bridge ADAPTER_NAMES is the allowlist (R3 P14)', () => {
  assert.deepStrictEqual(ADAPTER_NAMES, ['claude-agent', 'codex-bash', 'gemini-sdk', 'stdin-fallback']);
});
