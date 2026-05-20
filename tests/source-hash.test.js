const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { hashFile, hashContent } = require('../scripts/lib/source-hash');

test('hashFile returns sha256: prefixed hex for content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-sh-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello world');
  const h = hashFile(file);
  assert.match(h, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(h, hashContent('hello world'));
  fs.rmSync(dir, { recursive: true });
});

test('hashContent is deterministic for same input', () => {
  assert.strictEqual(hashContent('x'), hashContent('x'));
  assert.notStrictEqual(hashContent('x'), hashContent('y'));
});
