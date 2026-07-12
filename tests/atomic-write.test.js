const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { writeJsonAtomic, writeTextAtomic } = require('../scripts/lib/atomic-write');

test('writeJsonAtomic leaves live target and foreign temp byte-identical on exclusive-open collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-atomic-'));
  const target = path.join(dir, 'card.json');
  const liveBytes = Buffer.from('{"owner":"live"}\n');
  const foreignBytes = Buffer.from('foreign temp bytes\n');
  const fixedRandom = Buffer.from('0011223344556677', 'hex');
  const foreignTemp = `${target}.tmp.${process.pid}.${fixedRandom.toString('hex')}`;
  const randomBytes = crypto.randomBytes;

  fs.writeFileSync(target, liveBytes);
  fs.writeFileSync(foreignTemp, foreignBytes);
  crypto.randomBytes = () => fixedRandom;
  try {
    assert.throws(() => writeJsonAtomic(target, { owner: 'writer' }), { code: 'EEXIST' });
    assert.deepStrictEqual(fs.readFileSync(target), liveBytes);
    assert.equal(fs.existsSync(foreignTemp), true, 'writer must not delete an unowned temp');
    assert.deepStrictEqual(fs.readFileSync(foreignTemp), foreignBytes);
  } finally {
    crypto.randomBytes = randomBytes;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic overwrites existing file atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-atomic-'));
  const target = path.join(dir, 'data.json');
  writeJsonAtomic(target, { v: 1 });
  writeJsonAtomic(target, { v: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 2 });
  fs.rmSync(dir, { recursive: true });
});

test('writeTextAtomic overwrites a Unicode path without leaving temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm atomic text Ω '));
  const target = path.join(dir, '브리프 with spaces.md');
  writeTextAtomic(target, 'one');
  writeTextAtomic(target, 'two');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'two');
  assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(target)]);
  fs.rmSync(dir, { recursive: true });
});
