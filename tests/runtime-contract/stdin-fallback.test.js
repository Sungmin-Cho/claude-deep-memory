'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const adapter = require('../../scripts/lib/adapters/stdin-fallback');

const FIXTURE = path.join(__dirname, '../fixtures/runtime-recorded/stdin-fallback.jsonl');

test('stdin-fallback recorded fixture returns valid distill output', async () => {
  const out = await adapter.refine(
    { memory_type: 'pattern', claim: 'test claim' },
    'source excerpt',
    { recordedFixture: FIXTURE }
  );
  assert.ok(out.claim_refined.length > 0);
  assert.ok(Array.isArray(out.search_keywords));
});

test('stdin-fallback without fixture and batchMode:false throws ADAPTER_NOT_WIRED', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', {}),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});

test('stdin-fallback with batchMode:true throws ADAPTER_NOT_WIRED until Task 3b.7 prototype', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', { batchMode: true }),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});
