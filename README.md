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

#    Optional: opt into automatic hook capture (default OFF — global toggle)
/deep-memory-init --enable-capture     # ...or --disable-capture to turn it back off

# 2. Harvest the current project's sibling-plugin artifacts
/deep-memory-harvest

# 3. Get a memory brief for an upcoming task
/deep-memory-brief "implement Codex-compatible plugin manifest"

# 4. Periodic audit (stale memory, schema drift, lock recovery)
/deep-memory-audit
```

Automatic hook capture is **OFF by default** (it records tool I/O to
`~/.deep-memory/events/`, so it requires an explicit opt-in). `--enable-capture`
writes `capture.enabled: true` to the single global `config.yaml`, so the toggle
applies across **all** workspaces — but captured events/cards are tagged with the
working project's `project_id` and default to `privacy_level: local`, keeping
memory isolated per project. Manual paths (`/deep-memory-harvest`,
`/deep-memory-brief`) work with capture left off.

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
- Automatic hook capture is **OFF by default**; opt in with `/deep-memory-init --enable-capture` (revert with `--disable-capture`). Every actual toggle is recorded as a `capture-toggle` audit-log entry.
- `suppressions.yaml` for user-defined deny patterns

## Cross-runtime

Same skills run from Claude Code (slash), Codex (`$deep-memory:...`), Copilot CLI, Gemini CLI, Agent SDK (`Skill({skill:"deep-memory:..."})`). LLM distillation auto-detects the host adapter (claude-agent / codex-bash / gemini-sdk / stdin-fallback).

## Troubleshooting

### `FTS5 lexical index unavailable` warning during /deep-memory-harvest or /deep-memory-brief

This message means `better-sqlite3` could not be loaded in your current Node
runtime. Common causes:

- **Node v26+** — prebuilt better-sqlite3 binaries are not yet published for
  Node 26 at the time of v0.1.2, and the marketplace plugin cache is immutable
  (no on-the-fly rebuild). harvest still writes cards/events to disk, but the
  FTS5 index is skipped and `/deep-memory-brief` returns empty results.
- **Missing build toolchain** — if you've cleared the cache and tried to
  rebuild from source, you need Python 3, a C++ compiler, and make.

**Workaround for now (v0.1.2)**: use Node 22 LTS — `nvm install 22 && nvm use 22`
— and re-run `/deep-memory-harvest`.

**Future fix (v0.2.0)**: a sql.js WASM fallback wrapper will keep the index
functional regardless of native-module availability. Tracked in
[`docs/handoff-phase-4-6.md`](docs/handoff-phase-4-6.md).

## Documentation

- [Handoff for Phases 4 / 5 / 6 (post-v0.1.0 roadmap)](docs/handoff-phase-4-6.md)
- [v0.1.x immediate follow-up handoff](docs/handoff-v0.1.x-immediate.md)
- [CHANGELOG](CHANGELOG.md)
- [한국어 README](README.ko.md)

## License

MIT
