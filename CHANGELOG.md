# Changelog

All notable changes to deep-memory are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-09

### Fixed

- **Codex hook manifest loading.** The Codex plugin manifest now references
  `./hooks/hooks.json` instead of embedding the Claude hook object inline, which
  prevents Codex from ignoring hook configuration during session startup.
- **Codex hook parity.** The external Codex hook manifest registers the full
  Tier-1 capture hook set, including `PostToolUseFailure` and `SessionEnd`.
- **Release metadata drift.** MCP server metadata and hook event envelopes now
  read the package version, keeping runtime `producer_version` aligned with the
  plugin/package release version.

### Tests

- Added a manifest-drift regression that requires Codex hooks to use the
  external hooks manifest and verifies all expected hook entries are present.

## [0.4.0] - 2026-07-07

### Fixed

- **MCP tools reported fake success.** Several `deep-memory` MCP tools returned a
  success shape even when the underlying store lookup found nothing or could not
  resolve a card payload. They now fail closed — a fused row whose card payload
  cannot be located surfaces an honest error instead of an empty "success", and
  recall/lookup is scope-strict (global-privacy rows resolve only from the global
  scope; deprecated / non-applicable cards are filtered on the hybrid path).
- **Lossless distill cursor.** The deferred distill cursor is now held as a
  `(file, offset)` pair, so it survives a month rollover without losing or
  re-emitting drafts; the cursor advances only once every emitted draft is
  durably accounted for.
- **Session hooks are no longer destructive.** The capture hooks no longer mutate
  or discard live session state as a side effect.
- **Harvest envelope guard.** Envelope-guard warnings are redacted and bounded,
  the harvest wrapper validates `schema_version` before emit, and native-loader
  errors are redacted before they reach MCP warnings.

## [0.3.2] - 2026-05-25

### Added

- `--enable-capture` / `--disable-capture` flags on `/deep-memory-init` (mutually
  exclusive). Writes `config.yaml#capture.enabled`; the toggle is a global setting
  (single `config.yaml`) applying across all workspaces.
- `capture: {enabled: false, eager_distill: false}` block in the default config
  (capture default OFF per the privacy invariant).
- Each real capture toggle emits a single `capture-toggle` audit-log entry; a no-op
  writes nothing.

### Fixed

- **Capture toggle flag was never implemented.** The v0.3.0 design specified an
  auto-capture opt-in toggle, but `init` shipped without it: the default config had
  no `capture:` block, the CLI parser ignored any capture flag, and an existing
  `config.yaml` is never overwritten — so the only way to enable capture was to
  hand-edit the YAML. The README also referenced a `--capture` flag that did not
  exist.

## [0.3.1] - 2026-05-22

### Fixed

- **`.mcp.json` env-block interpolation crash** (surfaced at install time). Claude
  Code `.mcp.json` supports only `${VAR}` env interpolation, not bash-style
  `${VAR:-default}`. The literal string `${DEEP_MEMORY_ROOT:-${HOME}/.deep-memory}`
  was passed unchanged to the spawned MCP server, crashing it before the stdio
  handshake (`/reload-plugins` reported `Failed to reconnect to deep-memory: -32000`).
  Fix: remove the redundant env block; the MCP server already has the correct
  `DEEP_MEMORY_ROOT` / `~/.deep-memory` fallback.
- **Version bump 0.3.0 → 0.3.1** (release plumbing). The plugin manager keys its
  "already at latest version" check on the version string, not the git SHA, so
  v0.3.0 users who ran `/plugin update` after the env-block fix landed saw "already
  at latest" against a cached directory with the broken `.mcp.json`. The 0.3.1 patch
  forces a fresh fetch.

## [0.3.0] - 2026-05-22

agentmemory-style overhaul: cross-runtime hook capture + 3-layer memory model
(Events → Cards → Briefs) + MCP server with a slash-only mutation gate. This is a
major version (skipping 0.2.x — the sql.js fallback is delivered separately).

### Added

- **6 Tier-1 hook scripts** capturing SessionStart / UserPromptSubmit / PostToolUse /
  PostToolUseFailure / PreCompact / SessionEnd events from Claude Code and Codex
  (4-hook subset on Codex). All hooks are gated on `config.capture.enabled` before
  reading stdin (privacy invariant).
- **New `memory-hook-event` artifact kind** with an 11-field envelope and strict
  `additionalProperties: false` at every level. Co-exists with the v0.1.x
  `memory-event` schema (untouched).
- **3-layer memory model** (agentmemory pattern):
  - Events — per-month `events/YYYY-MM.jsonl`, append-only.
  - Cards — keyed by composite (memory_id, project_id) in the vector index.
  - Briefs — hybrid retrieval (FTS5 + vector) with session diversification.
- **5 deterministic detectors** (pattern, failure-case, decision, coding-style,
  session-summary fallback) for the zero-LLM Step A mappers.
- **Vector index** with a composite (memory_id, project_id) primary key (closes the
  C-R1 collision on the vector side); brute-force cosine with graceful fallback.
- **@xenova/transformers lazy loader** with a widened catch: any load-time error
  degrades gracefully to FTS5-only retrieval, with a model-version mismatch check.
- **RRF fusion** + **hybrid retrieval orchestrator** combining FTS5 + vector with
  session diversification and a graceful-matrix probe.
- **MCP server** with 10 tools + 5 resources + 2 prompts, spawned automatically by
  the host via `.mcp.json` (no manual setup). Mutation tools are enforced as
  slash-only.
- **3 new slash skills** for mutation paths: deep-memory-forget, deep-memory-promote,
  deep-memory-export. Each emits dual audit-log entries (consent + kind-specific).
- **Audit-log envelope writer** with 10 kinds and oneOf payload validation.

### Changed

- **4-pass uniform redaction**: three promoted rules (generic homedir, env-var,
  stack-trace homedir) now live in the shared redaction pipeline.
- **Byte-offset cursor** replaces the ISO-timestamp cursor. Format:
  `<YYYY-MM>.jsonl:<byte_offset>`, forward-only monotonic with cross-file rollover.

### Performance

- Single PostToolUse latency: p95 = 72 ms (target ≤ 400 ms).
- With concurrent distill: p95 = 66 ms (target ≤ 500 ms).
- Lock-split invariant: the distill pipeline does not hold `./lock` — LLM and
  embedding work runs outside critical sections.

### Migration

- v0.1.x → v0.3.0: the storage layout adds `events/`, `audit-log/`,
  `.last-distill-cursor/`, `indexes/vector.sqlite`, and `.embed-model-version`.
- v0.1.x reader compatibility: legacy flat-event records are still read via a legacy
  adapter that synthesizes a schema-compliant envelope.
- Capture default: OFF on non-interactive init. Users must explicitly opt in.

## [0.1.3] - 2026-05-21

### Fixed

- **Degraded-mode warnings now redacted.** A native-loader error string was
  concatenated raw into `cards.warnings` and `latest-harvest.json`; if it embedded an
  absolute homedir path, that path leaked to disk. Warnings are now routed through
  the redaction pipeline in both harvest and retrieve, replacing the homedir with `~/`.
- **`better-sqlite3` moved to `optionalDependencies`.** Previously a hard dependency,
  so `npm install` aborted when the native build failed — before the graceful runtime
  catch could execute. Now `npm install` succeeds even when the native binding fails;
  harvest and retrieve surface an explicit degraded-mode warning. (The marketplace
  cache, with a prebuilt binary baked in, is unaffected.)
- **`sibling-shape-smoke` test now fails loudly under `DEEP_MEMORY_FULL_SUITE=1`.**
  In CI runners that clone the full sibling suite, missing sibling fixtures fail
  instead of silently skipping. Default behavior (no env var) is unchanged, so
  partial-checkout development still works.

## [0.1.2] - 2026-05-21

### Fixed

- **Node v26+ first-use blocker — FTS5 graceful degradation.** v0.1.0 made harvest
  hard-throw when `better-sqlite3` could not be loaded — wrong for Node v26+
  environments where prebuilt binaries aren't yet available and the marketplace
  plugin cache is immutable (no on-the-fly rebuild). v0.1.2 reverses to graceful
  degradation:
    - harvest writes cards/events to disk normally; only the FTS5 upsert is skipped.
    - An explicit warning is surfaced via `cards.warnings` and mirrored in
      `.deep-memory/latest-harvest.json`.
    - `/deep-memory-brief` returns `{ memories: [], warnings: [...] }` with the same
      actionable message instead of hard-throwing.
    - (The sql.js WASM fallback is the proper fix, deferred to a later release.)
- **Step A mapper shape alignment (silent 0-card harvest blocker).** Four of the five
  Step A mappers expected an ideal-shape payload that did not match the sibling
  plugins' actual emit, so harvesting real sibling artifacts produced zero cards.
  All four were realigned to the sibling-real shapes:
    - `mapRecurringFindings` — consumes `findings[].{category, severity, occurrences,
      example_files, description, source_reports}`.
    - `mapEvolveInsights` — consumes the union of `insights_for_deep_work[]` and
      `insights_for_deep_review[]`.
    - `mapWorkReceipt` — `slices` is an aggregate object, not an array; emits one card
      per session receipt (slice-level memory deferred to a future source kind).
    - `mapDocsScan` — flattens `documents[].issues[]` to one card per issue, with
      severity-mapped confidence.
    - `mapWikiIndex` — unchanged (already matched).

### Added

- `sibling-shape-smoke` test — reads each sibling repo's actual fixture and asserts
  ≥ 1 card per mapper, so future sibling shape drift triggers an immediate failure
  instead of a silent regression. Skips gracefully when a sibling repo isn't checked out.

### Breaking

- **Mapper expectations rewritten.** Consumers that hand-built deep-memory artifacts
  against the old ideal-shape mapper rules must regenerate. No on-disk card format
  change and no envelope schema change — only the mapping rules from sibling source
  artifacts to memory drafts changed.

## [0.1.0] - 2026-05-20

### Added (MVP)

- Two manifests (Claude Code + Codex) with skill-based entry surfaces.
- 4 user-invocable skills (`deep-memory-init`, `deep-memory-harvest`,
  `deep-memory-brief`, `deep-memory-audit`) + 1 reference skill (`memory-schema`).
- Hybrid distill pipeline: rule-based Step A (5 memory types) + LLM sub-agent Step B,
  with graceful fallback to candidate status.
- Cross-runtime LLM adapter bridge (claude-agent / codex-bash / gemini-sdk /
  stdin-fallback).
- M3 envelope-wrapped events + cards + briefs.
- sqlite FTS5 lexical retrieval with 6-stage ranking (hard filter / project
  similarity / task similarity / evidence quality / applicability guard / diversity).
- 3-pass rule-based redaction (Step A input / Step B input / envelope wrap).
- `privacy_level: local | global` per card, with an explicit `--promote` gate.
- Atomic write (temp + fsync + rename + readback validate) + mkdir-based lock with
  `{pid, host, created_at}` metadata, stale detection (> 5 min), and `--unlock`
  recovery.
- Project lease with idempotent event keys.

### Known limitations

- **Multi-project memory_id collision (C-R1).** When two distinct projects in the
  same `~/.deep-memory` store produce the same `dedupe_key`, they share a `memory_id`.
  The FTS5 index is keyed on `memory_id` alone, so the second project's harvest
  overwrites the first project's index row. Card files on disk are preserved
  (scope-separated by `project_id`), but `/deep-memory-brief` may return phantom or
  missing results. v0.1.0 is **single-project-safe**; workaround: use a per-project
  `DEEP_MEMORY_ROOT`.
