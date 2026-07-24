'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const EVENT_ARTIFACTS = Object.freeze({
  'session-start': 'session-start.cjs',
  'user-prompt-submit': 'user-prompt-submit.cjs',
  'post-tool-use': 'post-tool-use.cjs',
  'post-tool-failure': 'post-tool-failure.cjs',
  'pre-compact': 'pre-compact.cjs',
  'session-end': 'session-end.cjs',
});
const MAX_BREADCRUMB_CHARS = 240;

function warn(message, stderr = console.error) {
  stderr(`[deep-memory] ${String(message).slice(0, MAX_BREADCRUMB_CHARS)}`);
}

function run(event, {
  spawnImpl = spawn,
  execPath = process.execPath,
  exists = existsSync,
  stderr = console.error,
} = {}) {
  const artifact = EVENT_ARTIFACTS[event];
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || '';
  if (!artifact || !pluginRoot) {
    warn(`${event || 'unknown'} hook: bootstrap configuration unavailable; capture skipped`, stderr);
    process.exitCode = 0;
    return Promise.resolve();
  }

  const script = path.join(pluginRoot, 'dist', 'hooks', artifact);
  if (!exists(script)) {
    warn(`${event} hook: missing ${artifact}; capture skipped`, stderr);
    process.exitCode = 0;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (message) => {
      if (settled) return;
      settled = true;
      if (message) warn(message, stderr);
      process.exitCode = 0;
      resolve();
    };
    let child;
    try {
      child = spawnImpl(execPath, [script], { stdio: 'inherit' });
    } catch (error) {
      finish(`${event} hook: spawn error ${error && error.message}; capture skipped`);
      return;
    }
    child.on('error', (error) => {
      finish(`${event} hook: spawn error ${error && error.message}; capture skipped`);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else if (signal) finish(`${event} hook: child signal ${signal}; capture skipped`);
      else finish(`${event} hook: child exit ${code}; capture skipped`);
    });
  });
}

module.exports = { EVENT_ARTIFACTS, MAX_BREADCRUMB_CHARS, run };
