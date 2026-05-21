# Changelog

All notable changes to deep-memory are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
