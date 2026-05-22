---
name: deep-memory-promote
description: Promote a memory card from privacy=local to privacy=global. The only path that exposes a card across projects. Slash-only entry point (spec §6.3.1 Gate 2 — autonomous MCP returns slash_only_in_v030). Use when a card has cross-project value confirmed through repeated retrieval. Writes mutation-consent + promote audit-log entries (R4-K).
allowed-tools: Read, Bash, Write
user-invocable: true
---

# /deep-memory-promote

Promote a card from local→global privacy. Global cards surface in
retrieval across all projects (not just the project where they were
born), so this is the ONLY path that exposes a card across projects.

## Arguments

- `<memory_id>` (required) — the ID of the card to promote.

## What it does

1. Validates `<memory_id>` exists with current `privacy: local`.
2. Writes `mutation-consent` audit-log entry.
3. Updates the card file: `privacy: local → global`.
4. Re-emits to FTS5 + vector indices with new privacy_level.
5. Writes `promote` audit-log entry `{memory_id, from_privacy: 'local', to_privacy: 'global'}`.

## Why slash-only

Per spec §6.3.1 Gate 2 + Gate 3 — privacy promotion is irreversible
(the global card surfaces in OTHER projects' retrieval immediately).
Requires explicit user judgment that the card has cross-project value.
