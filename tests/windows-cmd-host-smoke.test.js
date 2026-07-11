'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('native Windows cmd executes every commandWindows hook through a junction', {
  skip: process.platform !== 'win32' && 'native cmd-host execution runs only on Windows',
}, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cmd-hook Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const junction = path.join(fixture, 'plugin root Ω');
  fs.symlinkSync(root, junction, 'junction');
  const memoryRoot = path.join(fixture, 'memory root Ω');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), 'capture:\r\n  enabled: false\r\n');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const [event, entries] of Object.entries(hooks)) {
    const handler = entries.flatMap((entry) => entry.hooks || [])[0];
    assert.ok(handler.commandWindows, event);
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', handler.commandWindows], {
      cwd: fixture,
      env: { ...process.env, PLUGIN_ROOT: junction, DEEP_MEMORY_ROOT: memoryRoot, PROJECT_CWD: fixture },
      input: '{"session_id":"windows-smoke"}\r\n',
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    assert.equal(result.stdout, '', event);
  }
});
