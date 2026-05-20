'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, dedupeKey, applicabilitySeedHash } = require('../scripts/lib/dedupe');

test('normalize lowercases, collapses ws, alphanumeric-only', () => {
  assert.strictEqual(normalize('  Use A FOR B!! '), 'use a for b');
});

test('normalize keeps stop-words (F15) — "use A for B" must not equal "use A to B"', () => {
  // semantic distinction: "for" vs "to" can change meaning of a memory claim
  assert.notStrictEqual(normalize('use A for B'), normalize('use A to B'));
});

test('dedupeKey hashes type + normalized claim + applicability seed', () => {
  const k1 = dedupeKey('failure-case', 'Same claim', [{ value: 'typescript' }]);
  const k2 = dedupeKey('failure-case', 'Same claim', [{ value: 'python' }]);
  assert.notStrictEqual(k1, k2, 'different applicability seed should produce different key');
});

test('cross-type isolation: same normalized claim + different memory_type → different key (F22)', () => {
  const k1 = dedupeKey('failure-case', 'identical text', []);
  const k2 = dedupeKey('pattern', 'identical text', []);
  assert.notStrictEqual(k1, k2);
});

test('applicabilitySeedHash accepts both string-array and object-array forms', () => {
  const fromStrings = applicabilitySeedHash(['typescript', 'react']);
  const fromObjects = applicabilitySeedHash([{ value: 'typescript' }, { value: 'react' }]);
  assert.strictEqual(fromStrings, fromObjects,
    'string-array and object-array with same values must produce identical seed');
});
