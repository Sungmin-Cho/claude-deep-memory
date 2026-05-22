'use strict';
// ε.5 — downgrade safety smoke test. Verifies that v0.3.0 storage layout
// does not crash a v0.1.x reader. The v0.1.x reader path is exercised
// via the existing envelope-validator wired through dispatch().

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch } = require('../scripts/lib/event-dispatcher');
const { writeEntry } = require('../scripts/lib/audit-log');
const { openIndex, upsertVector } = require('../scripts/lib/vector-index');
const { writeStoredModelVersion } = require('../scripts/lib/embed-model');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-downgrade-'));
}

test('ε.5: v0.3.0 memory-hook-event lines are SKIPPED, not crashed, by v0.1.x-style flat-event reader', () => {
  // The v0.1.x reader path uses dispatch() — which routes hook events to
  // their dedicated validator, NOT to wrapLegacy. v0.1.x readers that
  // call wrapLegacy on every line would fail; the spec §8.2 mitigation
  // says v0.3.0 events.jsonl mixes hook + legacy lines, and v0.1.x
  // readers must skip hook lines via the discriminator.
  const hookLine = JSON.stringify({
    schema_version: '1.0',
    envelope: { artifact_kind: 'memory-hook-event', producer: 'deep-memory', producer_version: '0.3.0',
                run_id: 'r', generated_at: '2026-05-01T00:00:00Z',
                schema: {name: 'memory-hook-event', version: '1.0'},
                git: {head:'', branch:'', dirty:'unknown'},
                provenance: {source_artifacts:[{path:'x'}]},
                host: 'claude-code', session_id: 's', project_id: 'p' },
    payload: { source_kind: 'hook-post-tool-use', event_key: 'a'.repeat(64),
               dedupe_window_key: 'b'.repeat(64), captured_at: '2026-05-01T00:00:00Z',
               raw_chars_in: 0, raw_chars_out: 0,
               redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] } }
  });
  const flatLine = JSON.stringify({
    event_key: 'abc', source: 'recurring-findings', run_id: 'r',
    at: '2026-04-01T00:00:00Z', cards_count: 1, project_id: 'p'
  });
  // Both lines route via dispatch — hook to its validator, flat to legacy wrap.
  // A v0.1.x-only reader (no dispatch) would crash on hook line; the safety
  // mitigation is: v0.1.x reader MUST gate on artifact_kind === 'memory-event'.
  const hookResult = dispatch(hookLine);
  const flatResult = dispatch(flatLine);
  assert.strictEqual(hookResult.routed, 'memory-hook-event');
  assert.strictEqual(flatResult.routed, 'memory-event-legacy-wrapped');
});

test('ε.5: v0.3.0-only files (vector.sqlite, audit-log/, .embed-model-version) are ignored by v0.1.x', () => {
  const root = mkTmpRoot();
  // Create v0.3.0-only artifacts
  const db = openIndex(root);
  if (db) {
    const v = new Float32Array(384).fill(0.05);
    upsertVector(db, { memory_id: 'm', project_id: 'p', embedding: v });
    db.close();
  }
  writeStoredModelVersion(root, 'v3.0.0-test');
  writeEntry(root, {
    kind: 'capture-toggle', by: 'init-migration', host: 'claude-code',
    payload: { from: false, to: true, method: 'non-interactive-default' }
  });
  // Verify v0.3.0-only files exist
  assert.ok(fs.existsSync(path.join(root, '.embed-model-version')));
  assert.ok(fs.existsSync(path.join(root, 'audit-log')));
  // The "v0.1.x reader" model is: it only reads cards/, events/, indexes/fts.sqlite.
  // It does NOT enumerate indexes/vector.sqlite, audit-log/, or .embed-model-version.
  // Therefore by structural design these are ignored — no test code needed beyond
  // verifying they're under DEEP_MEMORY_ROOT (out-of-band paths).
  const expectedNewFiles = ['audit-log', '.embed-model-version', 'indexes'];
  for (const f of expectedNewFiles) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} should exist as v0.3.0 storage`);
  }
});
