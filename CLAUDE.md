@AGENTS.md

# Claude Code-specific guidance

Current version: `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`

Claude Code loads `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`, whose `hooks` pointer selects the six-event fail-open file `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.claude.json`. It also auto-loads the Codex hooks file — AGENTS.md §Runtime surfaces states the delegation rule that keeps each event captured exactly once.
