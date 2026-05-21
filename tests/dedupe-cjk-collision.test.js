'use strict';
// ITEM-3-r4: Unicode-aware normalize in dedupe.js
// Verifies that CJK/Korean/Japanese claims produce distinct dedupe_keys
// and are preserved through normalize (not collapsed to empty string).
const test = require('node:test');
const assert = require('node:assert');
const { normalize, dedupeKey } = require('../scripts/lib/dedupe');

test('normalize: Korean (Hangul) claim is preserved, not collapsed to empty string', () => {
  const result = normalize('메모리 회상 패턴');
  assert.strictEqual(result, '메모리 회상 패턴', `expected preserved Korean, got: ${JSON.stringify(result)}`);
});

test('dedupeKey: two distinct Korean claims yield distinct keys', () => {
  const k1 = dedupeKey('pattern', '메모리 회상', []);
  const k2 = dedupeKey('pattern', '다른 한국어', []);
  assert.notStrictEqual(k1, k2, 'distinct Korean claims must produce distinct dedupe_keys');
});

test('dedupeKey: Japanese and Chinese produce distinct keys', () => {
  const k1 = dedupeKey('pattern', '日本語', []);
  const k2 = dedupeKey('pattern', '中文', []);
  assert.notStrictEqual(k1, k2, 'Japanese vs Chinese must produce distinct dedupe_keys');
});

test('dedupeKey: ASCII back-compat — output is sha256:[a-f0-9]{64}', () => {
  const k = dedupeKey('pattern', 'codex skill', []);
  assert.match(k, /^sha256:[a-f0-9]{64}$/, `ASCII dedupeKey shape must be sha256:hex64, got: ${k}`);
});

test('normalize: ASCII back-compat — existing ASCII tests unaffected', () => {
  assert.strictEqual(normalize('  Use A FOR B!! '), 'use a for b');
  assert.notStrictEqual(normalize('use A for B'), normalize('use A to B'));
});

test('normalize: Arabic text is preserved (not collapsed)', () => {
  const result = normalize('عربي');
  // Arabic letters are \p{L} — should be preserved
  assert.ok(result.length > 0, `Arabic text must not collapse to empty string, got: ${JSON.stringify(result)}`);
});

test('normalize: Cyrillic text is preserved (not collapsed)', () => {
  const result = normalize('Привет мир');
  assert.ok(result.length > 0, `Cyrillic text must not collapse to empty string, got: ${JSON.stringify(result)}`);
});
