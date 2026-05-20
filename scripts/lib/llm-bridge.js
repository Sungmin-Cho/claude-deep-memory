// scripts/lib/llm-bridge.js (Phase 1 skeleton — Phase 3b will add schema validation)
// P14: ADAPTERS allowlist (Object.freeze) — adapter name from config/user never reaches require() path
// P15: from Phase 1, pass through adapterOpts so adapters can receive recordedFixture etc.
'use strict';
const { detect } = require('./adapter-registry');

const ADAPTERS = Object.freeze({
  'claude-agent': () => require('./adapters/claude-agent'),
  'codex-bash': () => require('./adapters/codex-bash'),
  'gemini-sdk': () => require('./adapters/gemini-sdk'),
  'stdin-fallback': () => require('./adapters/stdin-fallback'),
});

async function refine(eventDraft, sourceExcerpt, { adapter = 'auto', timeoutMs = 30000, ...adapterOpts } = {}) {
  const chosen = detect(adapter);
  const loader = ADAPTERS[chosen];
  if (!loader) throw new Error(`Unknown adapter '${chosen}'`);
  return Promise.race([
    loader().refine(eventDraft, sourceExcerpt, adapterOpts),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`LLM bridge timeout (${chosen}, ${timeoutMs}ms)`), { code: 'TIMEOUT' })), timeoutMs)),
  ]);
}

module.exports = { refine, ADAPTER_NAMES: Object.keys(ADAPTERS) };
