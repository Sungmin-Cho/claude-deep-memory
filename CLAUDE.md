# deep-memory — Project Guide for Claude

**Auto-loaded for plugin developers running Claude Code in this repo clone** (marketplace-installed users see README + skills entry surfaces). Project overview + drift-resistant structural notes only. Version-by-version notes belong in `CHANGELOG.md`.

## Project Overview

**deep-memory** is the 7th plugin in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace. It harvests artifacts emitted by sibling plugins (`deep-work`, `deep-review`, `deep-evolve`, `deep-docs`, `deep-wiki`, `deep-dashboard`) and distills them into reusable **memory cards** — patterns, failures, architecture decisions, experiment outcomes, coding-style rules — that future work can recall via task-specific memory briefs.

**Three-layer model:**
1. **Events** — raw harvest of sibling plugin artifacts (JSONL append-only)
2. **Cards** — distilled, M3-envelope-wrapped semantic memory (rule-based + sub-agent LLM)
3. **Briefs** — task-specific top-N retrieval (lexical FTS5 + project similarity)

## Cross-runtime surfaces

Skill-based entry — same skills run from Claude Code (`/deep-memory-*`), Codex (`$deep-memory:deep-memory-*`), Copilot CLI, Gemini CLI, Agent SDK (`Skill({skill:"deep-memory:..."})`).

## Directory Structure

```
deep-memory/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── agents/memory-distiller.md          # sub-agent (Read-only)
├── schemas/                             # normative JSON Schema (draft 2020-12)
├── scripts/{harvest,distill,retrieve,audit}.js + lib/
├── skills/{deep-memory-init,deep-memory-harvest,
│          deep-memory-brief,deep-memory-audit,memory-schema}/SKILL.md
└── tests/                               # node --test, with runtime-contract/
```

## MVP Commands

- `/deep-memory-init` — initialize `~/.deep-memory/` + project-profile
- `/deep-memory-harvest` — scan sibling artifacts → events → distill → cards
- `/deep-memory-brief "<task>"` — top-N memory brief for a task
- `/deep-memory-audit [--unlock | --promote <id>]` — schema/stale/lock/promotion audit

## Storage

- **Global**: `~/.deep-memory/` (override: env `DEEP_MEMORY_ROOT`). cards/events/indexes/projects/.leases/.lock.
- **Project-local**: `.deep-memory/` (gitignored). project-profile + latest-harvest/brief/audit.

## 🚨 Cross-repo Update Workflow

Every release: bump version in `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `package.json` (manifest-drift CI checks). Then sync **`/Users/sungmin/Dev/claude-plugins/deep-suite/`** — `marketplace.json` × 2 (sha + description) + `suite-extensions.json` (artifacts/data_flow). Then update CHANGELOG.md + CHANGELOG.ko.md.

## Privacy invariant

3-pass rule-based redaction (Step A input / Step B input / envelope wrap). `privacy_level: local` default — `--promote <id>` is the only path to `global`. Auto hook capture defaults **OFF** (`config.yaml#capture.enabled: false`); `/deep-memory-init --enable-capture` / `--disable-capture` toggles it (global config, all workspaces) via `scripts/lib/capture-toggle.js`, emitting a `capture-toggle` audit-log entry on each real transition.

## Pointers

- Spec: `docs/superpowers/specs/2026-05-20-deep-memory-design.md`
- Plan: `docs/superpowers/plans/2026-05-20-deep-memory-v0.1.0.md`
- Handoff (Phase 4-6): `docs/handoff-phase-4-6.md`
- CHANGELOG: `CHANGELOG.md` / `CHANGELOG.ko.md`
