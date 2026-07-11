// scripts/lib/adapters/codex-bash.js
// Codex CLI adapter for the memory-distiller sub-agent.
//
// Recorded fixtures remain available for deterministic characterization. Live
// refinement is mediated by a host-provided executable process spec with no
// free-form shell command.
'use strict';
const fs = require('node:fs');
const { dispatchHostMediated } = require('../host-mediated-dispatch');

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

async function refine(eventDraft, sourceExcerpt, options = {}) {
  const { recordedFixture = null, hostProcessSpec, hostDispatchTimeoutMs } = options;
  if (recordedFixture) {
    return readRecordedFixture(recordedFixture);
  }
  try {
    return await dispatchHostMediated({
      host: 'codex',
      eventDraft,
      sourceExcerpt,
      processSpec: hostProcessSpec,
      timeoutMs: hostDispatchTimeoutMs || 30000,
    });
  } catch (error) {
    if (error && error.code === 'host_dispatch_unavailable') {
      throw Object.assign(new Error(error.message), { code: 'ADAPTER_NOT_WIRED', cause: error });
    }
    throw error;
  }
}

module.exports = { refine };
