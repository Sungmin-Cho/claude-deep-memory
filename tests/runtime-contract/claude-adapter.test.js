'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const adapter = require('../../scripts/lib/adapters/claude-agent');

const FIXTURE = path.join(__dirname, '../fixtures/runtime-recorded/claude-agent.jsonl');

test('claude-adapter recorded fixture returns valid distill output', async () => {
  const out = await adapter.refine(
    { memory_type: 'failure-case', claim: 'test claim' },
    'source excerpt',
    { recordedFixture: FIXTURE }
  );
  assert.ok(out.claim_refined.length > 0);
  assert.ok(Array.isArray(out.search_keywords));
  assert.ok(out.search_keywords.length > 0);
  assert.ok(Array.isArray(out.non_applicability));
  assert.ok(Array.isArray(out.recommended_action));
  // sub-agent must NOT include source_id (orchestrator-owned)
  for (const n of out.non_applicability) {
    assert.strictEqual(n.source_id, undefined);
    assert.ok(n.confidence >= 0 && n.confidence <= 1);
  }
});

test('claude-adapter without recorded fixture and no live Agent throws typed ADAPTER_NOT_WIRED', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', { recordedFixture: null, liveAgent: false }),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});

test('claude-adapter with liveAgent:true (no fixture) still throws ADAPTER_NOT_WIRED until production wiring', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', { liveAgent: true }),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});

test('claude-adapter rejects empty recorded fixture with ADAPTER_FIXTURE_EMPTY', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-adapter-'));
  const empty = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(empty, '\n   \n');
  try {
    await assert.rejects(
      () => adapter.refine({}, '', { recordedFixture: empty }),
      (e) => e.code === 'ADAPTER_FIXTURE_EMPTY'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('claude-adapter rejects fixture without `output` field with ADAPTER_FIXTURE_INVALID', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-adapter-'));
  const bad = path.join(tmp, 'bad.jsonl');
  fs.writeFileSync(bad, JSON.stringify({ adapter: 'claude-agent' }) + '\n');
  try {
    await assert.rejects(
      () => adapter.refine({}, '', { recordedFixture: bad }),
      (e) => e.code === 'ADAPTER_FIXTURE_INVALID'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
