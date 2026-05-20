'use strict';
const { execSync } = require('node:child_process');

function detect(adapter = 'auto') {
  if (adapter !== 'auto') return adapter;
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude-agent';
  if (process.env.CODEX_PLUGIN_ROOT || hasCmd('codex')) return 'codex-bash';
  if (process.env.GEMINI_API_KEY) return 'gemini-sdk';
  return 'stdin-fallback';
}

function hasCmd(name) {
  try { execSync(`command -v ${name}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

module.exports = { detect };
