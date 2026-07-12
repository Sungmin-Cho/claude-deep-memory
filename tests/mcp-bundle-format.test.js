'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const normalizer = path.join(repoRoot, 'scripts', 'normalize-generated-bundle.js');

test('generated MCP bundle normalizer removes trailing whitespace idempotently', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bundle-format-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'bundle.cjs');
  fs.writeFileSync(target, 'const one = 1;  \nconst two = 2;\t\n');

  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(process.execPath, [normalizer, target], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  assert.equal(fs.readFileSync(target, 'utf8'), 'const one = 1;\nconst two = 2;\n');
});

test('committed MCP bundle contains no trailing whitespace', () => {
  const bundle = fs.readFileSync(path.join(repoRoot, 'dist', 'mcp-server.cjs'), 'utf8');
  assert.doesNotMatch(bundle, /[ \t]+$/m);
});

test('generated bundle normalizer preserves CRLF while removing trailing whitespace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bundle-format-crlf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'bundle.cjs');
  fs.writeFileSync(target, 'const one = 1;  \r\nconst two = 2;\t\r\n');
  const result = spawnSync(process.execPath, [normalizer, target], {
    cwd: repoRoot, encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const one = 1;\r\nconst two = 2;\r\n');
});
