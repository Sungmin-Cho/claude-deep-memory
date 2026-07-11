'use strict';

function detectHost(env = process.env) {
  if (env.PLUGIN_ROOT) return 'codex';
  if (env.CURSOR_PLUGIN_ROOT) return 'cursor';
  if (env.GEMINI_CLI_ROOT || env.GEMINI_API_KEY) return 'gemini-cli';
  if (env.CLINE_PLUGIN_ROOT) return 'cline';
  if (env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  return '(other)';
}

function adapterForHost(host) {
  if (host === 'claude-code') return 'claude-agent';
  if (host === 'codex') return 'codex-bash';
  if (host === 'gemini-cli') return 'gemini-sdk';
  return 'stdin-fallback';
}

module.exports = { detectHost, adapterForHost };
