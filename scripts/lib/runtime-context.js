'use strict';

function detectHost(env = process.env) {
  if (env.PLUGIN_ROOT) return 'codex';
  if (env.CURSOR_PLUGIN_ROOT) return 'cursor';
  if (env.GEMINI_CLI_ROOT) return 'gemini-cli';
  if (env.CLINE_PLUGIN_ROOT) return 'cline';
  if (env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  return '(other)';
}

module.exports = { detectHost };
