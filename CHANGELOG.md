# Changelog

All notable changes to deep-memory are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.2] - 2026-05-25

### Fixed

- **Capture toggle flag was never implemented.** The v0.3.0 spec (§3.6)
  designed an auto-capture opt-in toggle, but `init.js` shipped without it:
  `defaultConfigYaml()` had no `capture:` block, the CLI parser ignored any
  capture flag, and an existing `config.yaml` is never overwritten — so the
  only way to enable capture was to hand-edit the YAML. The CHANGELOG/README
  also referenced a `--capture` flag that did not exist (doc/code drift).

### Added

- **`--enable-capture` / `--disable-capture`** flags on `/deep-memory-init`
  (mutually exclusive → exit 1). Boolean flags matching spec §3.6 line 644.
  Writes `config.yaml#capture.enabled`; toggle is a global setting (single
  `config.yaml`) applying across all workspaces.
- **`scripts/lib/capture-toggle.js`** — `setCaptureEnabled(root, target, opts)`:
  targeted text edit (byte-compatible with the `common.mjs` hook reader regex),
  idempotent (a `capture-toggle` audit-log entry `{from, to, method}` is emitted
  only on a real transition, never on a no-op).
- **`scripts/lib/default-config.js`** — extracted `defaultConfigYaml()` into a
  standalone module (single source of truth; avoids an init↔capture-toggle
  require cycle) and added the `capture: {enabled: false, eager_distill: false}`
  block (capture default OFF per privacy invariant).
- **`writeTextAtomic`** in `scripts/lib/atomic-write.js` for raw-text
  (non-JSON) atomic writes of `config.yaml`.

### Tests

- `tests/capture-toggle.test.js` (10 cases): default-config block, enable /
  disable / idempotent no-op transitions, single audit entry per transition,
  legacy-config append path, init `run({capture})` wiring, CLI mutual-exclusion,
  and a hook-contract regression proving the writer output is recognized as
  enabled by the `post-tool-use` hook reader. Full suite: 357 pass / 0 fail.

## [0.3.1] - 2026-05-22

### Fixed

- **`.mcp.json` env-block interpolation crash** (Sonnet R1 W-1 finding;
  surfaced at install time). Claude Code `.mcp.json` only supports
  `${VAR}` env interpolation, not bash-style `${VAR:-default}`. The
  literal string `${DEEP_MEMORY_ROOT:-${HOME}/.deep-memory}` was passed
  unchanged to the spawned MCP server, crashing it before stdio handshake.
  `/reload-plugins` reported `Failed to reconnect to deep-memory: -32000`.
  Fix: remove the redundant env block from both `.mcp.json` and
  `.claude-plugin/plugin.json#mcpServers`. `scripts/mcp-server.mjs` already
  has the correct `process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(),
  '.deep-memory')` fallback.

- **Version bump 0.3.0 → 0.3.1** (release plumbing). Plugin manager keys
  its "already at latest version" check on the version string in
  `.claude-plugin/plugin.json`, not the git SHA. v0.3.0 users who tried
  `/plugin update` after the env-block fix landed on main saw the manager
  report "already at latest" because the cached 0.3.0 directory existed,
  even though the cached `.mcp.json` still had the broken env block. The
  0.3.1 patch forces a fresh fetch.

## [0.3.0] - 2026-05-22

agentmemory-style overhaul: cross-runtime hook capture + 3-layer memory model
(Events → Cards → Briefs) + MCP server with slash-only mutation gate.
This is a major version (skipping 0.2.x — sql.js fallback delivered separately).

Implementation followed a 4-round spec deep-review-loop (24 → 11 findings) +
2-round plan deep-review-loop (graduated CONCERN), then 6-phase TDD execution.
6-phase plan executed; final phase 4-way deep-review-loop scheduled separately.

### Added

- **6 Tier-1 hook scripts** (`scripts/hooks/*.mjs`) capturing
  SessionStart / UserPromptSubmit / PostToolUse / PostToolUseFailure /
  PreCompact / SessionEnd events from Claude Code + Codex (4-hook subset
  on Codex per spec §3.5). All hooks gated on `config.capture.enabled`
  BEFORE stdin read (PR1-D / R4-D privacy invariant).
- **New `memory-hook-event` artifact_kind** (schemas/memory-hook-event.schema.json)
  with 11-field envelope + strict `additionalProperties: false` at every level.
  Co-exists with v0.1.x `memory-event` schema (untouched, byte-stable).
- **3-layer memory model**: Events → Cards → Briefs per agentmemory pattern.
  - Layer 1 (Events): per-month `events/YYYY-MM.jsonl` append-only.
  - Layer 2 (Cards): existing v0.1.x cards/ directory, now keyed by
    composite (memory_id, project_id) in the vector index.
  - Layer 3 (Briefs): hybrid retrieve (FTS5 + vector) + session diversification.
- **5 deterministic detectors** (`scripts/lib/distill-hook-session.js`):
  pattern, failure-case, decision, coding-style, session-summary fallback.
  Zero-LLM Step A mappers per spec §4.2.
- **Vector index** (`scripts/lib/vector-index.js`) with COMPOSITE
  (memory_id, project_id) PRIMARY KEY closing C-R1 vector-side.
  Brute-force cosine; better-sqlite3 graceful-fallback.
- **@xenova/transformers lazy loader** (`scripts/lib/embed-model.js`)
  with widened catch (R4-I + PR2-E): any load-time error → graceful
  FTS5-only fallback. Model version mismatch check via
  `.embed-model-version` file (R3-G + R4-I).
- **RRF fusion** (`scripts/lib/rrf-fusion.js`) with composite key per PR2-F.
- **Hybrid retrieval orchestrator** (`scripts/lib/retrieve-hybrid.js`)
  combining FTS5 + vector with session diversification (γ.6) +
  graceful-matrix probe (γ.7).
- **MCP server** (`scripts/mcp-server.mjs`) with 10 tools + 5 resources
  + 2 prompts. Spawned automatically by host via `.mcp.json` (no manual
  setup). Mutation tools enforced as slash-only per Gate 2.
- **3 new slash skills** for mutation paths: deep-memory-forget,
  deep-memory-promote, deep-memory-export. Each emits dual audit-log
  entries (mutation-consent + kind-specific) per R4-K.
- **Audit-log envelope writer** (`scripts/lib/audit-log.js`) with 10 kinds
  and oneOf payload validation per R3-J / R4-E.

### Changed

- **4-pass uniform redaction**: 3 promoted rules (generic homedir,
  env-var, stack-trace homedir) now live in `scripts/lib/redact.js`
  shared pipeline. PR1-E / W2 / W3 fixes integrated.
- **Byte-offset cursor** (`scripts/lib/cursor.js`) replaces ISO-timestamp
  cursor per R3-A. Format: `<YYYY-MM>.jsonl:<byte_offset>` with
  forward-only monotonic + cross-file rollover allowed.

### Performance

- **G-α latency** (single PostToolUse): p95 = 72ms (target ≤400ms, 82% headroom)
- **G-β latency** (with concurrent distill): p95 = 66ms (target ≤500ms, 87% headroom)
- Lock-split invariant: distill-pipeline.js does NOT require `./lock` —
  LLM + embedding run outside critical sections.

### Deferred to v0.3.x

- γ.1 full FTS5 widening to composite key (v0.1.x carry; vector-side
  already composite, so retrieval is C-R1-safe in mixed mode).
- ε.3-ε.4 init.js multi-marker detection + migration cursor init.
- δ.16 audit skill SKILL.md Gate 2 awareness modification.
- δ.19 Gate 1 cross-project read scope flag in MCP server.
- hooks-stats.json per-hook counter telemetry.
- Full §3.2.1 fire-and-forget invariants (lease heartbeat, back-to-back
  coalesce) beyond detached+unref.

See `docs/handoff-v0.3.0-postrelease.md` for the full deferral list.

### Migration

- v0.1.x→v0.3.0: storage layout adds `events/`, `audit-log/`,
  `.last-distill-cursor/`, `indexes/vector.sqlite`, `.embed-model-version`.
- v0.1.x reader compatibility: legacy flat-event records continue to be
  read via `scripts/lib/event-dispatcher.js` legacy adapter (R4-H) with
  schema-compliant envelope synthesis.
- Capture default: OFF on non-interactive init (per spec §3.6 + R4-D).
  User must explicitly opt in via prompt or `/deep-memory-init --capture`.

## [0.1.3] - 2026-05-21

Round 1 deep-review-loop response (review report `2026-05-21-151916-review.md`,
verdict=CONCERN, 4 🟡 + 3 ℹ️). Fast-follow patch addressing 5 of 7 items.

### Fixed

- **Privacy invariant — degraded-mode warnings now redacted** (Codex adversarial 🟡 #2).
  `ftsLoadError` was concatenated raw into `cards.warnings` and `latest-harvest.json`;
  if the native loader error embedded an absolute homedir path, it leaked to disk.
  Now routed through `redactString` in both `scripts/harvest.js` and
  `scripts/retrieve.js`. Regression tests in `harvest-fts-silent-disable.test.js`
  + `retrieve-fts-degraded.test.js` inject a simulated error containing
  `os.homedir()` and assert the resulting warning contains `~/` instead.
- **`better-sqlite3` moved to `optionalDependencies`** (Codex 🟡 #1).
  Previously a hard `dependencies` entry, so `npm install` would abort when the
  native build failed — the v0.1.2 graceful runtime catch never got a chance to
  execute. Now `npm install` succeeds even when the native binding fails;
  `harvest.js` + `retrieve.js` runtime catches surface the explicit warning.
  Marketplace-cache scenario (prebuilt baked in) is unaffected. sql.js WASM
  fallback for v0.2.0 still tracked separately.
- **`tests/sibling-shape-smoke.test.js` env-gated hard-fail** (Opus 🟡 #3).
  When `DEEP_MEMORY_FULL_SUITE=1` is set (e.g. in CI runners that clone the
  full sibling suite), missing sibling fixtures now fail loudly instead of
  silently skipping. Default behavior (no env var) unchanged — partial-checkout
  dev still works.
- **`cards.warnings` regression coverage** (Opus 🟡 #4). New test in
  `harvest-fts-silent-disable.test.js` spawn-forks to simulate fts-load
  failure, calls `harvestArtifact()` against the recurring-findings fixture,
  and asserts `cards.warnings` is a non-empty array containing
  `FTS_DEGRADED_WARNING` (and is properly redacted). Closes the gap where
  v0.1.2 had zero coverage of the actual degraded-mode return value.
- **SKILL.md doc drift** (Opus ℹ️ #1). `deep-memory-brief/SKILL.md` +
  `deep-memory-harvest/SKILL.md` degraded-paths sections updated to match
  v0.1.2/v0.1.3 graceful behavior (was still describing pre-v0.1.2 hard-fail).

### Deferred to user

- "Breaking" label in v0.1.2 CHANGELOG (Opus ℹ️ #2) — editorial; current
  framing is conservative but not strictly wrong. Left for user discretion.

### Not addressed (rejected with rationale)

- Defensive-coding edge cases that quietly quarantine (Opus ℹ️ #3) — the
  noted edges (no `session_id`+no `task_description`, etc.) ARE correctly
  funneled to the quarantine path; that's the F1 contract. Adding tests
  for each would expand coverage without surfacing new failure modes.

## [0.1.2] - 2026-05-21

### Fixed

- **Node v26+ first-use blocker — FTS5 graceful degradation** — v0.1.0
  round-5 ITEM-4 made harvest hard-throw when `better-sqlite3` could not be
  loaded. That posture was wrong for Node v26+ environments where prebuilt
  binaries aren't yet available AND the marketplace plugin cache is immutable
  (no on-the-fly rebuild). v0.1.2 reverses to graceful degradation:
    - harvest writes cards/events to disk normally; FTS5 upsert is skipped.
    - An explicit warning is surfaced via `cards.warnings` (CLI summary), and
      mirrored in `.deep-memory/latest-harvest.json` under `warnings[]`.
    - `/deep-memory-brief` returns `{ memories: [], warnings: [...] }` with the
      same actionable message instead of hard-throwing.
    - `scripts/harvest.js` exports `FTS_DEGRADED_WARNING` + `isFtsAvailable()`
      for skill harnesses / tests.
    - sql.js WASM fallback is the proper fix, still deferred to v0.2.0.
  New tests: `tests/harvest-fts-silent-disable.test.js` (graceful behavior
  on harvest side) and `tests/retrieve-fts-degraded.test.js` (retrieve side).
- **Step A mapper shape alignment (silent 0-card harvest blocker)** — 4 of 5
  Step A mappers in v0.1.0 expected an ideal-shape `payload` that did not match
  the sibling plugins' actual emit. v0.1.0 produced silent 0-card harvest when
  consuming real sibling artifacts. Realigned all 4 mappers to sibling-real
  shapes:
    - `mapRecurringFindings` — consumes `findings[].{category, severity, occurrences, example_files, description, source_reports}` instead of the missing `findings[].{title, evidence, tags, first_seen}` fields. `description → claim`, `example_files → evidence_summary`, `[category, severity] → tags`.
    - `mapEvolveInsights` — consumes `payload.insights_for_deep_work[]` + `payload.insights_for_deep_review[]` (union) instead of the missing `payload.insights[]`. Item shape is `{pattern, evidence, source_archive_ids, suggestion}`; `suggestion → claim`, `pattern → title`, tag identifies the target side.
    - `mapWorkReceipt` — `payload.slices` is an aggregate object `{total, completed, spike}`, NOT an array. Adopted **Option A**: 1 card per session-receipt (summary). Slice-level memory is deferred to a future source-kind.
    - `mapDocsScan` — `payload.documents[].issues[]` (nested) instead of `payload.drifts[]`. Flatten: 1 issue = 1 card. Severity-mapped confidence (high=0.7, medium=0.5, low=0.3).
    - `mapWikiIndex` — unchanged (sibling shape already matched).
- Spec §7.1 mapper rule table rewritten in `docs/superpowers/specs/2026-05-20-deep-memory-design.md` against sibling-real shapes.
- v0.1.0 ideal-shape local test fixtures replaced with sibling-real shapes (`tests/fixtures/sample-{recurring-findings, evolve-insights, session-receipt-{success,failure}, last-scan}.json`).

### Added

- `tests/sibling-shape-smoke.test.js` — invariant smoke test that reads each
  sibling repo's actual fixture (`../../deep-{review,evolve,work,docs}/tests/fixtures/`)
  and asserts ≥1 card per mapper. Future sibling shape drift triggers an immediate
  red signal instead of a silent regression. Skips gracefully when a sibling
  repo isn't checked out.

### Breaking

- **Spec §7.1 mapper expectations rewritten.** Consumers that hand-built
  deep-memory artifacts against the old ideal-shape mapper rules must regenerate.
  No on-disk card format change; envelope schemas unchanged. Only the mapping
  rules from sibling source artifacts → memory drafts changed.

## [0.1.0] - 2026-05-20

### Added (MVP — Phase 0-3 of design spec)

- Two manifests (Claude Code + Codex) with skill-based entry surfaces
- 4 user-invocable skills (`deep-memory-init`, `deep-memory-harvest`, `deep-memory-brief`, `deep-memory-audit`) + 1 reference skill (`memory-schema`)
- Hybrid distill pipeline: rule-based Step A (5 memory types) + LLM sub-agent Step B with graceful fallback to candidate status
- Cross-runtime LLM adapter bridge (claude-agent / codex-bash / gemini-sdk / stdin-fallback)
- M3 envelope-wrapped events + cards + briefs
- sqlite FTS5 lexical retrieval with 6-stage ranking (hard filter / project sim / task sim / evidence quality / applicability guard / diversity)
- 3-pass rule-based redaction (Step A input / Step B input / envelope wrap)
- `privacy_level: local | global` per-card with explicit `--promote` gate
- Atomic write (temp+fsync+rename+readback validate) + mkdir-based lock with `{pid, host, created_at}` metadata + stale detect (>5min) + `--unlock` recovery
- Project lease with idempotent event keys (sha256(path+content_hash+run_id))
- 12 test suites including `runtime-contract/` per-adapter fixtures
- Suite integration: `deep-suite/.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json` + `suite-extensions.json` entries

### Known limitations

- **Multi-project memory_id collision (C-R1, tracked for v0.2.0)** — when two
  distinct projects in the same `~/.deep-memory` store harvest artifacts that
  produce the same `dedupe_key`, both projects share a `memory_id`. The lexical
  index (FTS5) is keyed on `memory_id` alone, so the second project's harvest
  overwrites the first project's index row. The card files on disk are preserved
  (scope-separated under `cards/<type>/<project_id>/`), but `/deep-memory-brief`
  may return phantom or missing results until v0.2.0 reworks the id scheme.
  v0.1.0 is **single-project-safe**. Workaround: use `DEEP_MEMORY_ROOT` per project.
