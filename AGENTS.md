# deep-memory - Codex Project Guide

deep-memory provides cross-project operational memory through Codex-native skills while retaining Claude Code compatibility.

Current version: `node -e "console.log(require('./.codex-plugin/plugin.json').version)"`

> Documentation follows `docs/DOCS_RULE.md`, the local canonical maintainer guide.

## Runtime surfaces

- Node 22 on native Windows, macOS, and Linux.
- Codex manifest and default hook discovery: `.codex-plugin/plugin.json` and `hooks/hooks.json`.
- Claude Code manifest: `.claude-plugin/plugin.json`.
- User skills: `skills/deep-memory-*/SKILL.md`.
- Authoritative distiller contract: `agents/memory-distiller.md`.
- Committed MCP bundle: `dist/mcp-server.cjs`.

Keep user memory, locks, review artifacts, and local documentation out of commits.

## Release verification

```text
npm run build:mcp
git diff --exit-code -- dist/mcp-server.cjs
npm run validate-manifest
npm test
```

Update suite marketplace pins only after the plugin release is merged.
