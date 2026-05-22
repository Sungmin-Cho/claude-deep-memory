'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCursor, writeCursor, advanceTo } = require('../scripts/lib/cursor');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cursor-'));
}

test('cursor: write/read roundtrip', () => {
  const dir = mkTmpRoot();
  writeCursor(dir, 'p1', '2026-05.jsonl', 184320);
  const c = readCursor(dir, 'p1');
  assert.deepStrictEqual(c, { file: '2026-05.jsonl', offset: 184320 });
});

test('cursor: missing cursor file returns null', () => {
  const dir = mkTmpRoot();
  assert.strictEqual(readCursor(dir, 'missing'), null);
});

test('cursor: advanceTo refuses regression within same file', () => {
  const dir = mkTmpRoot();
  writeCursor(dir, 'p1', '2026-05.jsonl', 1000);
  advanceTo(dir, 'p1', '2026-05.jsonl', 500);  // regression attempt
  const c = readCursor(dir, 'p1');
  assert.strictEqual(c.offset, 1000, 'cursor should NOT regress within same file');
});

test('cursor: advanceTo allows cross-month rollover (forward)', () => {
  const dir = mkTmpRoot();
  writeCursor(dir, 'p1', '2026-05.jsonl', 9999);
  advanceTo(dir, 'p1', '2026-06.jsonl', 0);
  const c = readCursor(dir, 'p1');
  assert.deepStrictEqual(c, { file: '2026-06.jsonl', offset: 0 },
    'forward cross-month rollover should advance to new file even if offset is smaller');
});

test('cursor: writeCursor atomic (temp+rename) leaves no .tmp on success', () => {
  const dir = mkTmpRoot();
  writeCursor(dir, 'p1', '2026-05.jsonl', 100);
  const cursorDir = path.join(dir, '.last-distill-cursor');
  const files = fs.readdirSync(cursorDir);
  // expect exactly the project file, no .tmp.<pid> remnant
  assert.deepStrictEqual(files.filter(f => f.includes('.tmp')), [],
    'no .tmp remnants after successful write');
});
