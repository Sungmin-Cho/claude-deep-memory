'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function copyFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-memory validator Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(root, fixture, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('node_modules') && !src.split(path.sep).includes('.git'),
  });
  return fixture;
}

test('validatePlugin accepts repository and its CLI handles a Unicode path', (t) => {
  const { validatePlugin } = require('../scripts/validate-manifest');
  assert.deepEqual(validatePlugin(root), []);
  const fixture = copyFixture(t);
  assert.deepEqual(validatePlugin(fixture), []);
  const result = spawnSync(process.execPath, ['scripts/validate-manifest.js', fixture], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('validator rejects forbidden Codex hook field and incomplete host surfaces', (t) => {
  const { validatePlugin } = require('../scripts/validate-manifest');
  const fixture = copyFixture(t);
  const codexPath = path.join(fixture, '.codex-plugin/plugin.json');
  const codex = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
  codex.hooks = './hooks/hooks.json';
  fs.writeFileSync(codexPath, JSON.stringify(codex, null, 2));
  assert.ok(validatePlugin(fixture).some((error) => error.includes('hooks')));

  delete codex.hooks;
  fs.writeFileSync(codexPath, JSON.stringify(codex, null, 2));
  const hooksPath = path.join(fixture, 'hooks/hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  delete hooks.hooks.SessionStart[0].hooks[0].commandWindows;
  hooks.hooks.SessionEnd = hooks.hooks.SessionStart;
  fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
  const errors = validatePlugin(fixture);
  assert.ok(errors.some((error) => error.includes('four supported events')));
  assert.ok(errors.some((error) => error.includes('command')));

  // Claude events live in the pointed-to bootstrap file now — dropping one
  // there must still trip the six-event contract.
  const claudeHooksPath = path.join(fixture, 'hooks/hooks.claude.json');
  const claudeHooks = JSON.parse(fs.readFileSync(claudeHooksPath, 'utf8'));
  delete claudeHooks.hooks.SessionEnd;
  fs.writeFileSync(claudeHooksPath, JSON.stringify(claudeHooks, null, 2));
  assert.ok(validatePlugin(fixture).some((error) => error.includes('six events')));
});
