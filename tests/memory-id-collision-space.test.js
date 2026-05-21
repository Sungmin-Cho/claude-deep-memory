'use strict';
// ITEM-2-r3: smoke test — 10k distinct dedupe_keys produce 10k distinct memory_ids (64-bit hash space).
// This is a documentation-grade test: the real argument for 64-bit is birthday math (collision
// probability ~p^2/2^64 which is negligible for realistic card counts), but we verify the
// implementation produces no collisions in a 10k draw as a basic sanity check.
const test = require('node:test');
const assert = require('node:assert');
const { memoryIdFor } = require('../scripts/harvest');

test('ITEM-2-r3: 10k distinct dedupe_keys produce 10k distinct memory_ids (no collision in 64-bit space)', () => {
  const COUNT = 10_000;
  const memoryIds = [];
  for (let i = 0; i < COUNT; i++) {
    // Construct a realistic dedupe_key shape (sha256-prefixed hex string, distinct per i)
    const dk = 'sha256:' + i.toString().padStart(64, '0');
    memoryIds.push(memoryIdFor('pattern', dk));
  }
  const unique = new Set(memoryIds);
  assert.strictEqual(unique.size, COUNT, `Expected ${COUNT} distinct memory_ids, got ${unique.size} (collision detected)`);
  // Also verify all ids match the expected format (64-bit = 16 hex chars)
  for (const id of memoryIds) {
    assert.match(id, /^mem_pattern_[a-f0-9]{16}$/, `memory_id format mismatch: ${id}`);
  }
});
