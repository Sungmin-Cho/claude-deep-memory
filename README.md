# deep-memory

> Cross-project semantic operational memory for the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

Harvests artifacts emitted by sibling deep-suite plugins, distills them into reusable memory cards (Hybrid: rule-based + LLM sub-agent), and surfaces task-specific memory briefs that future work can recall.

## Status

**v0.1.0 MVP** — Skeleton + harvest + distill + brief + audit. 244 tests passing. Phase 4-6 (writer integration / reasoning graph / dashboard telemetry) tracked in [`docs/handoff-phase-4-6.md`](docs/handoff-phase-4-6.md).

## Install

Via the `claude-deep-suite` marketplace:

```bash
# Claude Code
/plugin install deep-memory@claude-deep-suite

# Codex
codex plugin install deep-memory
```

Or directly from this repo with `--source url` pointed at the GitHub URL.

## Quick start

```bash
# 1. Initialize memory root (~/.deep-memory/ by default; override with DEEP_MEMORY_ROOT)
/deep-memory-init

# 2. Harvest the current project's sibling-plugin artifacts
/deep-memory-harvest

# 3. Get a memory brief for an upcoming task
/deep-memory-brief "implement Codex-compatible plugin manifest"

# 4. Periodic audit (stale memory, schema drift, lock recovery)
/deep-memory-audit
```

## Three-layer model

1. **Events** — append-only JSONL of raw harvest under `~/.deep-memory/events/YYYY-MM.jsonl`
2. **Cards** — distilled M3-envelope-wrapped semantic memory under `~/.deep-memory/cards/<type>/{global,project_id}/`
3. **Briefs** — top-N retrieval written to `.deep-memory/latest-brief.{json,md}` for the current project

## Skills

| Skill | Purpose |
|---|---|
| `deep-memory-init` | initialize memory root + project profile |
| `deep-memory-harvest` | scan sibling artifacts → distill → persist |
| `deep-memory-brief` | top-N memory brief for a task |
| `deep-memory-audit` | schema/stale/redaction/lock/promote audit |
| `memory-schema` (reference) | M3 envelope + card schema + state machine |

## Privacy

- 3-pass rule-based redaction (Step A input / Step B input / envelope wrap)
- `privacy_level: local` per-card default; `--promote <id>` is the only path to global memory
- `suppressions.yaml` for user-defined deny patterns

## Cross-runtime

Same skills run from Claude Code (slash), Codex (`$deep-memory:...`), Copilot CLI, Gemini CLI, Agent SDK (`Skill({skill:"deep-memory:..."})`). LLM distillation auto-detects the host adapter (claude-agent / codex-bash / gemini-sdk / stdin-fallback).

## Documentation

- [Handoff for Phases 4 / 5 / 6 (post-v0.1.0 roadmap)](docs/handoff-phase-4-6.md)
- [CHANGELOG](CHANGELOG.md)
- [한국어 README](README.ko.md)

## License

MIT
