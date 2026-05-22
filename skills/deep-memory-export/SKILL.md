---
name: deep-memory-export
description: Export memory cards to a JSON file. Cross-project export (scope=all) is slash-only (spec §6.3.1 Gate 3 — autonomous MCP returns slash_only_in_v030). Use when sharing a memory snapshot with a teammate, archiving before reset, or auditing what's been captured. Writes mutation-consent + cross-project-export audit-log entries (R4-K).
allowed-tools: Read, Bash, Write
user-invocable: true
---

# /deep-memory-export

Export memory cards to a JSON file.

## Arguments

- `--scope` (required) — `current-project` or `all` (cross-project).
- `--target <path>` (required) — output JSON file path.

## What it does

1. Validates `<path>` is writable.
2. Writes `mutation-consent` audit-log entry.
3. Reads cards from `cards/<type>/<project>/` (scope=current) or
   `cards/<type>/<*>/` (scope=all).
4. Writes a single JSON file with the card array.
5. Writes `cross-project-export` audit-log entry `{scope, exported_count, target_path}`.

## Why slash-only (cross-project)

Per spec §6.3.1 Gate 3 — `scope=all` reveals all projects' memory in a
single export, which a third party reading the JSON could use to
correlate users across projects. Requires explicit user consent.

Even `scope=current-project` is slash-only in v0.3.0 to keep the export
audit-log dual emission consistent across modes.
