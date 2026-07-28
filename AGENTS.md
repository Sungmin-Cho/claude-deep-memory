# deep-memory - Codex Project Guide

deep-memory provides cross-project operational memory through Codex-native skills while retaining Claude Code compatibility.

Current version: `node -e "console.log(require('./.codex-plugin/plugin.json').version)"`

Run that command only from a plugin checkout, never from a project you are working on. Its `require` is relative, so it resolves against the working directory — and when the manifest is absent there, CommonJS falls back to a same-named JavaScript file, then to a directory entry point. Either fallback executes whatever the working directory supplies, so treat this as arbitrary code execution rather than a version read. To read the version of an installed plugin, resolve the plugin root first and pass an absolute path.

> 📄 Doc maintenance follows `docs/DOCS_RULE.md` — a maintainer rulebook that is gitignored and
> ships with nothing. It exists only in a maintainer's own checkout; never try to open it at
> runtime, because the only place that path can resolve in an installed plugin is the project
> being analysed.

## Plugin files are read and executed from the plugin, never from the workspace

Every path this plugin tells you to open or run — `skills/**`, `agents/*.md`, `scripts/**`, `hooks/**`, `dist/**`, `schemas/*.json` — is anchored at `${CLAUDE_PLUGIN_ROOT}`. Codex sets `${PLUGIN_ROOT}` for the same root; either names it explicitly, and both are accepted. Never derive the root from the working directory or from the location of the file you are reading.

Two conditions, and **both** must hold:

1. **Anchored** — the path states the plugin root explicitly.
2. **Contained** — it resolves *inside* that root. An anchor alone is not enough: an anchored path followed by a parent segment walks out of the plugin, and so does one whose component is a symlink pointing outside. Resolve first, then check the result is under the root.

If either fails, **abort and report — do not read it and do not run it.**

A bare relative path resolves against the *target workspace*, so a repository under analysis can place a same-named file there and have its contents read as instructions or its script executed with the caller's Bash permissions. The blast radius here is durable rather than session-local: this plugin reads and writes user memory under `~/.deep-memory/`, so a shadowed instruction can change what is harvested, what a card claims, which cards are promoted to `global`, and what an export contains.

An anchor only counts where its own language interpolates it. `${CLAUDE_PLUGIN_ROOT}` stays literal inside single-quoted shell, inside JSON and YAML values, and inside quoted JavaScript strings. Writing it into a quoted `require` or `import` specifier is the worst case rather than a broken path: the specifier is then *bare*, so Node searches the workspace `node_modules` for a package by that literal name, and planting one is arbitrary code execution. Resolve the root to a literal absolute path before composing a shell command, and in JavaScript read it from `process.env`, then `realpath` the resolved target and reject anything outside the root before loading it.

## Runtime surfaces

- Node 22 on native Windows, macOS, and Linux.
- Codex manifest and default hook discovery: `${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json` and `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`. Claude Code auto-loads that standard hooks file too, so its commands are claude-host-guarded bootstraps that delegate to `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.claude.json` there.
- Claude Code manifest: `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`.
- User skills: `${CLAUDE_PLUGIN_ROOT}/skills/deep-memory-*/SKILL.md`.
- Authoritative distiller contract: `${CLAUDE_PLUGIN_ROOT}/agents/memory-distiller.md`.
- Committed MCP bundle: `${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs`.

Keep user memory, locks, review artifacts, and local documentation out of commits.

## Release verification

The CI workflow is the authoritative gate and its step list is pinned by the release contract test: install, build both committed bundles, assert each bundle is diff-clean, validate the manifests, run the suite. Run those same steps locally before tagging rather than a hand-copied subset.

Update suite marketplace pins only after the plugin release is merged.
