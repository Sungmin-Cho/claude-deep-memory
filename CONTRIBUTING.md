# Contributing to deep-memory

Thanks for your interest in improving **deep-memory** — cross-project semantic
operational memory for the
[claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite). It harvests
artifacts emitted by sibling plugins, distills them into reusable memory cards, and
surfaces task-specific briefs across Claude Code and Codex.

## Development setup

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-memory.git
cd claude-deep-memory
npm install
```

Node 22+ is required (ESM project). `better-sqlite3` and `sql.js` are
`optionalDependencies` — `npm install` succeeds even if the native `better-sqlite3`
build fails, and retrieval degrades gracefully to a WASM/FTS5-only path.

## Tests

```bash
npm test                    # node --test across tests/ (+ runtime-contract, hooks, mcp-tools)
npm run validate-manifest   # plugin manifest checks
```

Focused suites are available too: `npm run test:envelope` and
`npm run test:redaction`.

## Conventions

- **Documentation** follows `docs/DOCS_RULE.md` (the local maintainer guide).
  In short: `README.md` is evergreen, `CHANGELOG.md` owns release history, and
  `CLAUDE.md` / `AGENTS.md` stay short. README and CHANGELOG are bilingual
  (`*.md` + `*.ko.md`) and kept structurally in sync.
- **Version triple-sync**: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` must always carry the same version.
- **Changelog**: follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) —
  one-line, user-observable bullets under `### Added` / `### Changed` / `### Fixed`.
- **Privacy is a hard invariant**: automatic hook capture stays OFF by default, and
  redaction runs before anything is persisted. See [`SECURITY.md`](SECURITY.md).

## Pull requests

1. Branch from `main`.
2. Keep changes focused, and add a `[Unreleased]` CHANGELOG entry (both languages)
   for any user-observable change.
3. Make sure `npm test` is green.
4. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
