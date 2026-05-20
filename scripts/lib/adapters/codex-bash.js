// scripts/lib/adapters/codex-bash.js
// Codex CLI adapter for the memory-distiller sub-agent.
//
// MVP exercises the recordedFixture path. Production dispatch wires `codex review
// --json` via spawn, captures stdout, JSON.parse — same envelope as claude-agent.
// Until that lands, liveCodex:true throws ADAPTER_NOT_WIRED so harvest falls back
// to candidate (spec §7.2) instead of crashing.
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

async function refine(eventDraft, sourceExcerpt, { recordedFixture = null, liveCodex = false } = {}) {
  if (recordedFixture) {
    return readRecordedFixture(recordedFixture);
  }
  if (liveCodex) {
    // Future: spawn('codex', ['review', '--json'], {input: prompt + envelope JSON, timeout})
    throw Object.assign(
      new Error('codex-bash live dispatch not yet wired — pass {recordedFixture: ...} for MVP'),
      { code: 'ADAPTER_NOT_WIRED' }
    );
  }
  throw Object.assign(
    new Error('codex-bash: no recorded fixture and live codex CLI disabled'),
    { code: 'ADAPTER_NOT_WIRED' }
  );
}

module.exports = { refine };
