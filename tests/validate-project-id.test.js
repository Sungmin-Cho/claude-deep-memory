'use strict';
// ITEM-2-r4: pure unit tests for validateProjectId / isValidProjectId.
const test = require('node:test');
const assert = require('node:assert');
const { validateProjectId, isValidProjectId, PROJECT_ID_RE } = require('../scripts/lib/validate-project-id');

// ─── validateProjectId ────────────────────────────────────────────────────────

test('validateProjectId: accepts valid proj_[a-f0-9]{12} id', () => {
  assert.strictEqual(validateProjectId('proj_a1b2c3d4e5f6'), 'proj_a1b2c3d4e5f6');
  assert.strictEqual(validateProjectId('proj_aaaaaaaaaaaa'), 'proj_aaaaaaaaaaaa');
  assert.strictEqual(validateProjectId('proj_000000000000'), 'proj_000000000000');
  assert.strictEqual(validateProjectId('proj_abcdef012345'), 'proj_abcdef012345');
});

test('validateProjectId: rejects empty string', () => {
  assert.throws(
    () => validateProjectId(''),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects path traversal attempt', () => {
  assert.throws(
    () => validateProjectId('../../etc'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
  assert.throws(
    () => validateProjectId('../escape'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects uppercase hex', () => {
  assert.throws(
    () => validateProjectId('proj_AAAAAAAAAAAA'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects wrong prefix', () => {
  assert.throws(
    () => validateProjectId('foo_a1b2c3d4e5f6'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects id shorter than 12 hex chars', () => {
  assert.throws(
    () => validateProjectId('proj_a1b2c3'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects id longer than 12 hex chars', () => {
  assert.throws(
    () => validateProjectId('proj_a1b2c3d4e5f6aa'),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

test('validateProjectId: rejects non-string', () => {
  assert.throws(
    () => validateProjectId(null),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
  assert.throws(
    () => validateProjectId(123),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
  assert.throws(
    () => validateProjectId(undefined),
    (e) => e.code === 'INVALID_PROJECT_ID'
  );
});

// ─── isValidProjectId ─────────────────────────────────────────────────────────

test('isValidProjectId: returns true for valid ids', () => {
  assert.strictEqual(isValidProjectId('proj_a1b2c3d4e5f6'), true);
  assert.strictEqual(isValidProjectId('proj_aaaaaaaaaaaa'), true);
});

test('isValidProjectId: returns false for invalid ids (no throw)', () => {
  assert.strictEqual(isValidProjectId(''), false);
  assert.strictEqual(isValidProjectId('../../etc'), false);
  assert.strictEqual(isValidProjectId('proj_AAAA'), false);
  assert.strictEqual(isValidProjectId('foo_a1b2c3d4e5f6'), false);
  assert.strictEqual(isValidProjectId(null), false);
  assert.strictEqual(isValidProjectId(undefined), false);
});

// ─── PROJECT_ID_RE ────────────────────────────────────────────────────────────

test('PROJECT_ID_RE exports the authoritative regex', () => {
  assert.ok(PROJECT_ID_RE instanceof RegExp);
  assert.ok(PROJECT_ID_RE.test('proj_a1b2c3d4e5f6'));
  assert.ok(!PROJECT_ID_RE.test('proj_ZZZZZZZZZZZZ'));
});
