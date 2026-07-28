---
name: deep-memory-forget
description: Record a memory-card deletion request with consent + audit-log dual emission. Does not yet remove the card body or its index rows. Slash-only. Use when a card is wrong, outdated, or holds content that should be marked for removal.
allowed-tools: Read, Bash, Write
user-invocable: true
---

# /deep-memory-forget

Delete a memory card from the deep-memory store.

## Arguments

- `<memory_id>` (required) — the ID of the card to delete (e.g. `mem_abc123`).
- `<reason>` (recommended) — short reason, recorded in the audit log. It is the **second
  positional argument**, not a flag: `forget.js` reads `argv[3]` directly, so calling it as
  `--reason "<text>"` records the literal string `--reason` as the reason.

## What it does

`node "${CLAUDE_PLUGIN_ROOT}/scripts/forget.js" <memory_id> [reason]` emits the audit pair and prints `{status: 'audit_logged', consent_id, forget_id}`.

It does not remove the card body or its index rows. The script says so in its own output note, and the containment-checked `unlinkContainedCard` helper is wired only into the promote path. So the audit entry is the durable record of the request; if you also remove the body, go through a containment-checked path rather than a bare `rm` under `~/.deep-memory/`, which would bypass the scope and symlink checks and can desynchronise the FTS5 index from `cards/`.

## Why slash-only

Deletion is designed as a permanent mutation, so it is never autonomous: the MCP `deep_memory_forget` tool returns `slash_only_in_v030`, forcing every deletion through this explicit user-driven path.

## Audit log

Exactly two lines per invocation, sharing one `at` timestamp — `writeMutationPair` computes it once and passes it to both:

1. `{kind: 'mutation-consent', payload: {tool: 'forget', args: {...}}}`
2. `{kind: 'forget', payload: {memory_id, reason}}`
