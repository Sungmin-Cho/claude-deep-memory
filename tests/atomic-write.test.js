const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJsonAtomic } = require('../scripts/lib/atomic-write');

test('writeJsonAtomic writes file readable as JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-atomic-'));
  const target = path.join(dir, 'card.json');
  writeJsonAtomic(target, { hello: 'world' });
  const r = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepStrictEqual(r, { hello: 'world' });
  assert.ok(!fs.existsSync(target + '.tmp'));
  fs.rmSync(dir, { recursive: true });
});

test('writeJsonAtomic overwrites existing file atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-atomic-'));
  const target = path.join(dir, 'data.json');
  writeJsonAtomic(target, { v: 1 });
  writeJsonAtomic(target, { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 2 });
  fs.rmSync(dir, { recursive: true });
});
