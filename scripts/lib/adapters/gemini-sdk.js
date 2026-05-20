// scripts/lib/adapters/gemini-sdk.js
// Gemini SDK adapter — minimal stub for the ADAPTERS allowlist in llm-bridge.
//
// MVP only honours recordedFixture; live SDK dispatch is deferred. The allowlist
// in llm-bridge.js requires every key to resolve to a module — without this file
// the allowlist crashes at load time when adapter-registry returns 'gemini-sdk'.
'use strict';
const fs = require('node:fs');

async function refine(eventDraft, sourceExcerpt, { recordedFixture = null } = {}) {
  if (recordedFixture) {
    const text = fs.readFileSync(recordedFixture, 'utf8').trim();
    const rec = JSON.parse(text.split('\n').filter(Boolean)[0]);
    if (!rec.output) {
      throw Object.assign(
        new Error(`Recorded fixture missing 'output' field: ${recordedFixture}`),
        { code: 'ADAPTER_FIXTURE_INVALID' }
      );
    }
    return rec.output;
  }
  throw Object.assign(
    new Error('gemini-sdk adapter not yet wired — pass {recordedFixture: ...} for MVP'),
    { code: 'ADAPTER_NOT_WIRED' }
  );
}

module.exports = { refine };
