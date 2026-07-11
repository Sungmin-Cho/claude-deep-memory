'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const codexEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'];
const claudeEvents = [...codexEvents, 'PostToolUseFailure', 'SessionEnd'];
const scripts = {
  SessionStart: 'session-start.mjs',
  UserPromptSubmit: 'user-prompt-submit.mjs',
  PostToolUse: 'post-tool-use.mjs',
  PostToolUseFailure: 'post-tool-failure.mjs',
  PreCompact: 'pre-compact.mjs',
  SessionEnd: 'session-end.mjs',
};

function onlyHandler(entries) {
  const handlers = entries.flatMap((entry) => entry.hooks || []);
  assert.equal(handlers.length, 1);
  return handlers[0];
}

test('Task 1 atomically establishes exact Codex and Claude hook surfaces', () => {
  const codex = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const discovered = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
  assert.equal(Object.hasOwn(codex, 'hooks'), false);
  assert.deepEqual(Object.keys(discovered.hooks).sort(), codexEvents.sort());
  assert.deepEqual(Object.keys(claude.hooks).sort(), claudeEvents.sort());

  for (const event of codexEvents) {
    const handler = onlyHandler(discovered.hooks[event]);
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, `node "\${PLUGIN_ROOT}/scripts/hooks/${scripts[event]}"`);
    assert.equal(handler.commandWindows, `node "%PLUGIN_ROOT%\\scripts\\hooks\\${scripts[event]}"`);
  }
  for (const event of claudeEvents) {
    const handler = onlyHandler(claude.hooks[event]);
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hooks/${scripts[event]}"`);
  }
});

test('every supported hook script exits cleanly and silently for CRLF disabled/malformed input', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-hook-path Ω '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const memoryRoot = path.join(fixture, 'memory root');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), 'capture:\r\n  enabled: false\r\n');
  for (const script of Object.values(scripts)) {
    for (const input of ['{"session_id":"s"}\r\n', 'malformed {{{\r\n']) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/hooks', script)], {
        cwd: fixture,
        env: { ...process.env, DEEP_MEMORY_ROOT: memoryRoot, PROJECT_CWD: fixture },
        input,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.equal(result.stdout, '', script);
      assert.equal(result.stderr, '', script);
    }
  }
});
