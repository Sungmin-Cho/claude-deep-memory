// scripts/lib/adapters/claude-agent.js
// Claude Code Agent-tool adapter for the memory-distiller sub-agent.
//
// Recorded fixtures remain available for deterministic characterization. Live
// refinement is mediated by a host-provided executable process spec; this
// adapter never constructs a shell command or duplicates the agent prompt.
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
      host: 'claude-code',
      eventDraft,
      sourceExcerpt,
      processSpec: hostProcessSpec,
      timeoutMs: hostDispatchTimeoutMs || 30000,
    });
  } catch (error) {
    // Preserve the direct-adapter compatibility code. llm-bridge translates it
    // back to the public host_dispatch_unavailable code for production callers.
    if (error && error.code === 'host_dispatch_unavailable') {
      throw Object.assign(new Error(error.message), { code: 'ADAPTER_NOT_WIRED', cause: error });
    }
    throw error;
  }
}

module.exports = { refine };
