@AGENTS.md

# Claude Code-specific guidance

Current version: `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`

Run that command only from a plugin checkout, never from a project you are working on — its relative `require` resolves against the working directory, and CommonJS falls back to a same-named JavaScript file or directory entry point when the manifest is missing, which executes whatever that directory supplies. AGENTS.md states the full rule.

Claude Code loads `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`, whose `hooks` pointer selects the six-event fail-open file `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.claude.json`. It also auto-loads the Codex hooks file — AGENTS.md §Runtime surfaces states the delegation rule that keeps each event captured exactly once.
