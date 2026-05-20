'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const adapter = require('../../scripts/lib/adapters/codex-bash');

const FIXTURE = path.join(__dirname, '../fixtures/runtime-recorded/codex-bash.jsonl');

test('codex-adapter recorded fixture returns valid distill output', async () => {
  const out = await adapter.refine(
    { memory_type: 'failure-case', claim: 'test claim' },
    'source excerpt',
    { recordedFixture: FIXTURE }
  );
  assert.ok(out.claim_refined.length > 0);
  assert.ok(Array.isArray(out.search_keywords));
  assert.ok(Array.isArray(out.recommended_action));
  // schema invariant: no source_id on sub-agent output
  for (const n of out.non_applicability) {
    assert.strictEqual(n.source_id, undefined);
  }
});

test('codex-adapter without fixture and liveCodex:false throws ADAPTER_NOT_WIRED', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', {}),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});

test('codex-adapter with liveCodex:true throws ADAPTER_NOT_WIRED until codex CLI wiring lands', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', { liveCodex: true }),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});
