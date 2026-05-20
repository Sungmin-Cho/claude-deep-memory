// scripts/lib/adapters/stdin-fallback.js
// Last-resort adapter for offline / CI environments with no host LLM.
//
// MVP exercises the recordedFixture path (deterministic CI tests). The batch
// mode prototype (collect drafts → emit prompt to stderr → read JSON from stdin)
// is gated behind Task 3b.7 — until that lands, non-fixture invocations throw
// ADAPTER_NOT_WIRED so harvest falls back to candidate (spec §7.2).
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

async function refine(eventDraft, sourceExcerpt, { recordedFixture = null, batchMode = false } = {}) {
  if (recordedFixture) {
    return readRecordedFixture(recordedFixture);
  }
  if (batchMode) {
    // Task 3b.7 — batch prototype wires this:
    //   process.stderr.write(promptTemplate + JSON.stringify(eventDraft))
    //   read JSON response from process.stdin until EOF / sentinel
    throw Object.assign(
      new Error('stdin-fallback batch mode not yet wired — pass {recordedFixture: ...} for MVP'),
      { code: 'ADAPTER_NOT_WIRED' }
    );
  }
  throw Object.assign(
    new Error('stdin-fallback: no recorded fixture and batch mode disabled'),
    { code: 'ADAPTER_NOT_WIRED' }
  );
}

module.exports = { refine };
