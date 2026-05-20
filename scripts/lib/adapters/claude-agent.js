// scripts/lib/adapters/claude-agent.js
// Claude Code Agent-tool adapter for the memory-distiller sub-agent.
//
// MVP exercises the recordedFixture path (deterministic CI tests). The live
// dispatch hook (`liveAgent: true`) is intentionally NOT wired — a future
// release will add the actual `Agent({subagent_type: "memory-distiller"})` call
// here. Throwing ADAPTER_NOT_WIRED today lets harvest gracefully degrade to
// candidate (spec §7.2) instead of crashing.
'use strict';
const fs = require('node:fs');

function readRecordedFixture(fixturePath) {
  const text = fs.readFileSync(fixturePath, 'utf8').trim();
  if (!text) {
    throw Object.assign(
      new Error(`Recorded fixture is empty: ${fixturePath}`),
      { code: 'ADAPTER_FIXTURE_EMPTY' }
    );
  }
  const firstLine = text.split('\n').filter(Boolean)[0];
  const rec = JSON.parse(firstLine);
  if (!rec.output) {
    throw Object.assign(
      new Error(`Recorded fixture missing 'output' field: ${fixturePath}`),
      { code: 'ADAPTER_FIXTURE_INVALID' }
    );
  }
  return rec.output;
}

async function refine(eventDraft, sourceExcerpt, { recordedFixture = null, liveAgent = false } = {}) {
  if (recordedFixture) {
    return readRecordedFixture(recordedFixture);
  }
  if (liveAgent) {
    throw Object.assign(
      new Error('claude-agent live dispatch not yet wired — pass {recordedFixture: ...} for MVP'),
      { code: 'ADAPTER_NOT_WIRED' }
    );
  }
  // P4: typed code so harvest catches and falls back to candidate (no crash)
  throw Object.assign(
    new Error('claude-agent: no recorded fixture and live Agent disabled'),
    { code: 'ADAPTER_NOT_WIRED' }
  );
}

module.exports = { refine };
