# Handoff — v0.3.0 post-release backlog

Items intentionally deferred from the v0.3.0 implementation to a follow-on
v0.3.x patch series. Each item includes spec reference, scope, and
acceptance criteria so the next session can pick up without re-discovery.

## High-priority (target v0.3.1)

### 1. γ.1 — Full FTS5 widening to composite (memory_id, project_id) key

**Scope:** modify `scripts/lib/fts-index.js` so the FTS5 table's `memory_id`
PRIMARY KEY becomes the composite `(memory_id, project_id)`. Currently the
vector index uses the composite key (C-R1-safe on the vector side), but the
FTS5 lexical index inherits the v0.1.x single-key bug.

**Acceptance:**
- `tests/cross-project-filter.test.js`: same memory_id across two projects
  remains distinct in FTS5 search.
- No regression in `tests/retrieve-ranking.test.js` baseline.
- Migration: existing rows are re-keyed in place via `ALTER TABLE` or
  index rebuild.

### 2. ε.3-ε.4 — init.js multi-marker detection + migration cursor init

**Scope:** modify `scripts/init.js` to:
- detect existing storage version via `.storage-version` file OR (if absent)
  scan up to 50 cards' `envelope.producer_version` and use lex-max (R3-D + R4-J)
- non-interactive default for `capture.enabled` = `false` + warning entry in
  `latest-distill.json` (R4-D)
- v0.1.x→v0.3.0 migration: initialize `.last-distill-cursor/<proj>` to
  `<current-month>.jsonl:<file_size>` (byte-offset format, R3-A)
- write `.storage-version` = "0.3"

**Acceptance:**
- 4 scenarios green: fresh interactive, fresh non-interactive, v0.2.x
  upgrade interactive, v0.2.x upgrade non-interactive.

### 3. δ.16 + δ.19 — audit skill modify + Gate 1 scope flag

**Scope:**
- `skills/deep-memory-audit/SKILL.md` modification to reference Gate 2
  dual-emission semantics (audit operations write mutation-consent first).
- `scripts/mcp-server.mjs` recall/search/smart_search tools: add `scope`
  argument (`current-project` | `all`); when `scope=all` is requested via
  autonomous MCP, emit `cross-project-read` audit-log entry with
  `projects_read[]` list.

**Acceptance:**
- Audit skill body explains R4-K dual emission.
- MCP integration test: autonomous recall with `scope=all` produces exactly
  1 `cross-project-read` audit-log entry per call.

## Medium-priority (target v0.3.2)

### 4. hooks-stats.json telemetry

**Scope:** per-hook event counters written atomically by each hook script
into `<repo>/.deep-memory/hooks-stats.json` for status-resource consumption.
Plan W5 deferred sub-item.

### 5. Full §3.2.1 fire-and-forget invariants

**Scope:** lease record + heartbeat in `.leases/<session_id>` per spec
§3.2.1; back-to-back coalesce check based on `last_heartbeat_at < 30s`.
Currently only `detached+unref` is implemented.

**Acceptance:**
- `tests/back-to-back-hook-fire.test.js` extended: 2 hooks within 1s spawn
  exactly 1 distill child (second coalesces).
- `.lock` + `.leases/` cleaned within 60s after both hooks complete.

### 6. Cross-repo sync (deep-suite marketplace.json + suite-extensions.json)

**Scope:** sync v0.3.0 metadata to `/Users/sungmin/Dev/claude-plugins/deep-suite/`:
- `marketplace.json` × 2 — bump deep-memory version + update sha + description
- `suite-extensions.json` — update artifacts + data_flow entries

This is a separate repo touch and requires the sibling repo to be present.
The plugin's CLAUDE.md (§ "🚨 Cross-repo Update Workflow") describes the
procedure; the next session should execute it after final-phase deep-review-loop.

## Low-priority (post-v0.3.x)

### 7. Real LLM-batched refineBatch

Current `refineBatch` (scripts/lib/llm-bridge.js) is sequential per-draft.
Plan β.3 envisioned a true single-LLM-call batch (all drafts in one prompt).
Requires adapter prompt redesign in `agents/memory-distiller.md` to accept
array input + array output.

### 8. v0.3.x roadmap items

- sql.js fallback wiring for vector.sqlite (mirrors v0.2.0 FTS5 work).
- Real session-summary card writer (currently emits a draft only;
  full Step B → card commit chain awaits the final-phase wiring).
- Audit skill enhancement: surface deferred-line backlog from
  `latest-distill.json` warnings.

## Test coverage gaps

- **Live LLM round-trip with refineBatch**: current tests use `skip_llm: true`
  in `distill-pipeline.test.js`. Real adapter integration test deferred to
  v0.3.x.
- **MCP integration smoke**: `tests/mcp-tools/forget-slash-only.test.js`
  covers 8 cases (Gate 2 + tools/list). Full 10-tool + 5-resource +
  2-prompt round-trip with a real MCP client is deferred.
- **G-α-latency in CI**: currently gated by `LATENCY=1` env (manual run).
  CI matrix configuration to set this flag on a dedicated benchmark job
  is deferred to v0.3.x.

## Sources

- Implementation plan: `docs/superpowers/plans/2026-05-22-deep-memory-v0.3.0.md`
- Design spec: `docs/superpowers/specs/2026-05-22-deep-memory-v0.3.0-design.md`
- Plan deep-review-loop: 2 rounds (Round 1: 11 🔴 + 9 🟡 + 4 ℹ️ → fixed;
  Round 2: 0 🔴 + 5 🟡 + 4 ℹ️ → graduate with all 11 PR1-x fixes landed).
- Spec deep-review-loop: 4 rounds (24 findings → 11 → 12 → graduate via §3.C).
