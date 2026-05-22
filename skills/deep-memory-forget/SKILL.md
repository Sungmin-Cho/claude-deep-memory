---
name: deep-memory-forget
description: Delete a memory card by ID with mandatory consent + audit-log dual emission. Slash-only entry point (spec §6.3.1 Gate 2 — autonomous MCP calls return slash_only_in_v030). Use when a memory card is wrong, outdated, or contains sensitive content that must be erased. Writes mutation-consent + forget audit-log entries (R4-K dual emission).
allowed-tools: Read, Bash, Write
user-invocable: true
---

# /deep-memory-forget

Delete a memory card from the deep-memory store.

## Arguments

- `<memory_id>` (required) — the ID of the card to delete (e.g., `mem_abc123`).
- `--reason "<text>"` (recommended) — short reason for the deletion, recorded in audit log.

## What it does

1. Validates `<memory_id>` exists under `cards/<type>/<project>/`.
2. Writes an audit-log `mutation-consent` entry (R4-K dual emission).
3. Deletes the card file + removes from FTS5 + vector indices.
4. Writes an audit-log `forget` entry with `memory_id` + `reason`.

## Why slash-only

Mutation is permanent — even though we keep the audit-log entry, the
card body is gone. Per spec §6.3.1 Gate 2 (v0.3.0 R3-B option-a), the
autonomous MCP `deep_memory_forget` tool returns `slash_only_in_v030`,
forcing all deletions through this explicit user-driven path.

## Audit log

Every invocation produces exactly 2 audit-log lines per R4-K:
1. `{kind: 'mutation-consent', payload: {tool: 'forget', args: {...}}}`
2. `{kind: 'forget',           payload: {memory_id, reason}}`

The two `at` timestamps are within 1ms.
