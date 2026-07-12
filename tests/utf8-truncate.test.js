'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { truncateUtf8 } = require('../scripts/lib/utf8-truncate');

function expectedPrefix(value, limit) {
  let out = '';
  for (const codePoint of String(value)) {
    if (Buffer.byteLength(out + codePoint, 'utf8') > limit) break;
    out += codePoint;
  }
  return out;
}

function assertBoundary(value, limit) {
  const actual = truncateUtf8(value, limit);
  assert.equal(actual, expectedPrefix(value, limit));
  assert.ok(Buffer.byteLength(actual, 'utf8') <= limit);
  assert.doesNotMatch(actual, /\uFFFD/);
  assert.equal(Buffer.from(actual, 'utf8').toString('utf8'), actual);
}

test('returns the original string when it is already inside the byte limit', () => {
  for (const value of ['', 'ascii', '한글', '🧠', 'e\u0301 mixed 한글 🧠']) {
    const bytes = Buffer.byteLength(value, 'utf8');
    assert.equal(truncateUtf8(value, bytes), value);
    assert.equal(truncateUtf8(value, bytes + 1), value);
  }
});

test('keeps the longest whole-code-point prefix at the 4096-byte boundary', () => {
  const values = [
    'a'.repeat(4096),
    'a'.repeat(4095) + '한' + 'tail',
    'a'.repeat(4094) + '한' + 'tail',
    'a'.repeat(4095) + '🧠' + 'tail',
    'a'.repeat(4093) + '🧠' + 'tail',
    ('한🧠e\u0301'.repeat(800)) + 'tail',
  ];
  for (const value of values) assertBoundary(value, 4096);
});

test('small limits never split Korean syllables, emoji, or surrogate pairs', () => {
  const value = '한🧠A';
  for (const limit of [0, 1, 2, 3, 4]) assertBoundary(value, limit);
  assert.equal(truncateUtf8(value, 2), '');
  assert.equal(truncateUtf8(value, 3), '한');
  assert.equal(truncateUtf8('🧠x', 3), '');
  assert.equal(truncateUtf8('🧠x', 4), '🧠');
});

test('rejects invalid limits', () => {
  for (const limit of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => truncateUtf8('x', limit), RangeError);
  }
});
