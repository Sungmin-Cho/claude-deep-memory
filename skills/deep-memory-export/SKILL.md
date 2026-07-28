---
name: deep-memory-export
description: "Export memory cards to a JSON file — snapshot sharing, pre-reset archiving, capture audits. Slash-only; the MCP tool never exports. Emits `mutation-consent` + `cross-project-export` audit entries."
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
2. Writes the `mutation-consent` audit-log entry.
3. Reads cards from `cards/<type>/<project>/` (`scope=current-project`) or `cards/<type>/*/` (`scope=all`).
4. Writes a single JSON file holding the card array.
5. Writes the `cross-project-export` audit-log entry. Its payload is schema-fixed: `{scope, exported_count, target_path}`.

There is no export helper script — this skill performs the steps with its own tools.

## Why slash-only

`scope=all` reveals every project's memory in one file, which a third party reading the JSON could use to correlate a user across projects, so it is gated: the MCP tool refuses it with `slash_only_in_v030`.

`scope=current-project` is past that gate but still never runs autonomously — the MCP tool answers `not_implemented` and points back here. Both scopes therefore reach the store only through this explicit user-driven path, which is what keeps the audit-log dual emission consistent across modes.
