---
name: deep-memory-promote
description: "Promote a memory card from `privacy_level: local` to `global` — the only path that exposes a card to other projects. Slash-only. Use when repeated retrieval has confirmed cross-project value."
allowed-tools: Read, Bash, Write
user-invocable: true
---

# /deep-memory-promote

Promote a card from `local` to `global`. Global cards surface in retrieval across all projects, not just the one they were born in, so this is the only path that exposes a card across projects.

## Arguments

- `<memory_id>` (required) — the ID of the card to promote.

## What it does

One implementation backs both entry points: `promoteCard()` in `${CLAUDE_PLUGIN_ROOT}/scripts/audit.js`, reachable as `--promote <memory_id> [--project <project_id>]`. The `deep-memory-audit` skill documents the procedure; this skill is the direct entry to it.

What you must know before invoking:

- It requires a validated current-project scope and refuses without one (`PROJECT_SCOPE_REQUIRED`). `--project` must match the trusted profile.
- It runs inside the global `<memory_root>/.lock`, so it serialises against harvest rather than racing it. A held lock surfaces as `LOCK_HELD` — retry.
- A card that is already global raises `ALREADY_GLOBAL`; an unknown id raises `NOT_FOUND`.
- Only the lexical FTS5 row is re-emitted, with `project_id: ''`. There is no vector-index write in this path, and when `better-sqlite3` is unavailable the card still moves while the index step is skipped.

Emit the `mutation-consent` + `promote` audit-log pair for the invocation.

## Why slash-only

Promotion is irreversible in practice — the global card appears in other projects' retrieval immediately — so it needs explicit user judgement that the card has cross-project value.
