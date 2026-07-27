@AGENTS.md

# Claude Code-specific guidance

Current version: `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`

- Claude Code manifest: `.claude-plugin/plugin.json` (hooks pointer); six-event fail-open hook file: `hooks/hooks.claude.json`.
- Codex manifest and default hook discovery: `.codex-plugin/plugin.json` and `hooks/hooks.json`. Claude Code auto-loads the standard `hooks/hooks.json` too, so its commands are claude-host-guarded bootstraps that delegate to `hooks/hooks.claude.json` there.
