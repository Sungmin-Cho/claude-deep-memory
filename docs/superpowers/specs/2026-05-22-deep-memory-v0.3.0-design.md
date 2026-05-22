# deep-memory v0.3.0 — agentmemory-style overhaul (standalone-first)

| Field | Value |
|---|---|
| **Spec ID** | `2026-05-22-deep-memory-v0.3.0-design` |
| **Author** | Sungmin-Cho |
| **Date** | 2026-05-22 |
| **Branch** | `feat/agentmemory-overhaul` |
| **Target version** | `0.3.0` |
| **Predecessor track** | `v0.2.0` (sql.js WASM fallback — must ship first; see `docs/handoff-v0.2.0-sql-js-fallback.md`) |
| **Reference upstream** | https://github.com/rohitg00/agentmemory (Apache-2.0, npm `@agentmemory/agentmemory@0.9.21`) |
| **Status** | DRAFT — rounds 1+2+3+4 responses applied (cumulative 62 ACCEPT / 1 DEFER, all grep verifications green). Spec graduated to writing-plans per deep-review-loop §3.C judgment (4 rounds + 12 reviewer responses + Opus×2 explicit "no need for further loop"). |

---

## 0. Identity & Goal

`deep-memory` v0.1.x is a deep-suite **artifact harvester**: explicit
`/deep-memory-harvest` scans sibling-plugin emissions (deep-review,
deep-evolve, deep-work, deep-docs, deep-wiki) and distills them into
M3-envelope memory cards. Without those siblings, the plugin is dormant.

`deep-memory` v0.3.0 turns this into a **standalone-first cross-host
memory plugin** that mirrors the capture-rich, retrieval-rich UX of
`agentmemory` while preserving every existing deep-memory invariant
(M3 envelope, 5 memory_type taxonomy, rule-based 3-pass redaction +
new Pass 0, project lease + global mkdir lock, atomic write +
fsync + readback, state machine, privacy_level `local`/`global`
with explicit promote gate).

The new identity:

> *"v0.3.0 captures the agent's behavior automatically through host
> hooks, distills it into the existing 5 memory_type cards, retrieves
> it via hybrid (FTS5 + local vector) search with RRF fusion, and
> exposes it through an MCP server that any MCP-capable host auto-wires
> on plugin install. deep-suite siblings remain a supported source —
> just no longer required."*

### Non-identity claims

- Not a daemon. No background server, no port, no separate REST/viewer
  surface in v0.3.0 (see §10 Non-goals).
- Not an iii-engine reimplementation. We do not adopt `iii-engine`,
  WebSocket on `:49134`, or Rust binaries.
- Not a TypeScript rewrite. JS + JSDoc + ajv schema. Build step = 0.
- Not a 4-tier storage redesign. The 4-tier metaphor
  (Working/Episodic/Semantic/Procedural) is a documentation overlay;
  on-disk layout is the existing `events/` + `cards/` duality.

---

## 1. Decision Summary (brainstorming outcomes)

These eight decisions are load-bearing for the rest of the spec.
Changing any of them changes the design upstream of this point.

| # | Topic | Decision | Rationale (short) |
|---|---|---|---|
| D1 | Scope | **B + standalone**: absorb agentmemory's core (auto capture, hybrid retrieval, MCP) while keeping deep-suite integration optional; usable without any sibling plugin. | Maximum value for solo users; preserves existing sibling consumers. |
| D2 | Capture surface | **A**: hooks lead, `/deep-memory-harvest` becomes secondary (sibling-only), add `/deep-memory-remember` for explicit save. | Hooks give silent, zero-friction capture matching agentmemory's UX. |
| D3 | Data model | **A**: events↔cards duality strengthened. Hook events land in `events/YYYY-MM.jsonl` (Working tier in 4-tier metaphor); existing 5 memory_type cards remain the only distilled artifact. | Zero breaking change to envelope/schema/state machine. |
| D4 | Retrieval | **A**: local vector + RRF. `@xenova/transformers` + `all-MiniLM-L6-v2` as optional dep; FTS5 + cosine fused with RRF k=60; keep existing 6-stage rerank as the post-fusion ranker. | Offline, free, no API keys; parity with agentmemory default. |
| D5 | External surface | **A** (with clarification): MCP server only, auto-wired by host via `mcpServers` in `plugin.json`. No daemon, no port, no separate REST/viewer in v0.3.0. | One install → fully functional. Daemon adds operational burden. |
| D6 | Backend | **A**: self-contained — SQLite (better-sqlite3 + sql.js fallback from v0.2.0) + `@xenova/transformers` + Node-native RRF/vector index. | Plugin install must just work; no external binaries. |
| D7 | Language | **A**: JS + JSDoc + ajv. No TypeScript / build step. | Marketplace plugin install simplicity; smallest diff from v0.1.x. |
| D8 | Release | **A**: v0.2.0 (sql.js) ships first → v0.3.0 is a separate track absorbing agentmemory parity. | Clear review/release cadence; reasonable migration cost per user. |

> Note: D8 implies v0.3.0 work is **blocked** until v0.2.0 ships. The
> v0.2.0 scope is fully defined in `docs/handoff-v0.2.0-sql-js-fallback.md`
> and is out of scope for this spec.

---

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Host (Claude Code / Codex / Cursor / …)             │
│  ┌─────────────────┐  ┌────────────────┐  ┌─────────────────────┐    │
│  │  Hook scripts   │  │  Slash skills  │  │  MCP stdio server   │    │
│  │  (12 lifecycle, │  │  /deep-memory* │  │  (auto-spawned by   │    │
│  │   Tier-1 = 6)   │  │  + /remember,  │  │   host from         │    │
│  │                 │  │   /recall, …   │  │   plugin.json       │    │
│  └────────┬────────┘  └────────┬───────┘  │   mcpServers entry) │    │
│           │                    │          └──────────┬──────────┘    │
│           │                    │                     │               │
└───────────┼────────────────────┼─────────────────────┼───────────────┘
            ▼                    ▼                     ▼
   ╔══════════════════════════════════════════════════════════════════╗
   ║      CAPTURE LAYER  (Working tier — 4-tier metaphor)             ║
   ║                                                                  ║
   ║   hook→event normalizer    skill→event       MCP→event           ║
   ║       (Pass 0 redact)      (Pass 0 redact)   (Pass 0 redact)     ║
   ║   ──────────────────────────────────────────────────────────     ║
   ║                  events/YYYY-MM.jsonl                            ║
   ║   (append-only, dedup'd by event_key + 5-min sliding window)     ║
   ║   + (optional) sibling artifact harvest from deep-suite plugins  ║
   ╚════════════════════════════════════════╤═════════════════════════╝
                                            ▼
   ╔══════════════════════════════════════════════════════════════════╗
   ║      DISTILL LAYER  (Episodic + Semantic + Procedural)           ║
   ║                                                                  ║
   ║  Step A: 6 rule-based mappers                                    ║
   ║     5 sibling-source mappers (unchanged from v0.1.x)             ║
   ║     1 NEW mapper: mapHookSession() with 5 detectors              ║
   ║         + sessionSummary fallback                                ║
   ║  Pass 1 redact → Step B (LLM sub-agent, batched: ≤5/call)        ║
   ║  Pass 2 redact → schema validate (memory-card-distill-output)    ║
   ║  Pass 3 redact → M3 envelope wrap → atomic write                 ║
   ║  → cards/<memory_type>/<project_id>/<memory_id>.json             ║
   ║                                                                  ║
   ║  Triggers: Lazy (default) · Eager (hook opt-in) · Explicit       ║
   ╚════════════════════════════════════════╤═════════════════════════╝
                                            ▼
   ╔══════════════════════════════════════════════════════════════════╗
   ║      RETRIEVAL LAYER                                             ║
   ║                                                                  ║
   ║  indexes/lexical.sqlite  (FTS5 BM25 — same as v0.1.x/v0.2.0)     ║
   ║  indexes/vector.sqlite   (NEW — Float32 BLOB, brute-force cosine)║
   ║                                                                  ║
   ║  hybrid_search(query, project_id):                               ║
   ║    1. FTS5 top-K   (K=30 default)                                ║
   ║    2. vector top-K (K=30 default, skipped if @xenova absent)     ║
   ║    3. RRF fusion (k=60) → top-60 fused                           ║
   ║    4. existing 6-stage rerank → top-N                            ║
   ║  → brief (Markdown + JSON)                                       ║
   ╚══════════════════════════════════════════════════════════════════╝
```

### Five design principles

1. **Multi-channel capture, single distill pipeline.** No matter the
   surface (hook / skill / MCP), every observation lands in
   `events/YYYY-MM.jsonl` first and follows the same Step A→B distill
   to produce the same M3-envelope 5-type cards.

2. **Additive storage (no breaking changes to v0.1.x artifacts).** Existing
   `~/.deep-memory/{cards, events, indexes, projects}` directories and
   the v0.1.x `memory-event` schema are unchanged. v0.3.0 adds:
   - **new artifact_kind**: `memory-hook-event` (separate schema file
     `schemas/memory-hook-event.schema.json`, distinct from the existing
     `memory-event` schema which stays at `schema_version "1.0"`).
   - **new SQLite index**: `indexes/vector.sqlite`.
   - **new metadata dirs/files**: `audit-log/`, `.last-distill-cursor/`,
     `.embed-model-version`, `.storage-version`.
   - Both `memory-event` and `memory-hook-event` records co-exist in
     `events/YYYY-MM.jsonl` (one record per line, distinguished by
     `envelope.artifact_kind`). Existing readers that ajv-validate
     against `memory-event` schema simply skip non-matching lines
     (graceful filter — v0.1.x readers were already designed to ignore
     malformed lines). v0.3.0 readers handle both artifact_kinds.

3. **Plugin install = fully functional.** Host (Claude Code / Codex /
   Cursor) auto-spawns the stdio MCP server from the `mcpServers` entry
   in `plugin.json`. No external daemon, no port collision, no separate
   binary. `@xenova/transformers` is an optional dependency — its
   absence triggers FTS5-only graceful degrade with explicit warning.

4. **Standalone first, siblings opt-in.** Hook capture alone produces
   meaningful memory and briefs. Siblings, when installed, supply
   additional sources via the unchanged 5 v0.1.x mappers
   (`/deep-memory-harvest` reused for that path).

5. **No iii-engine, no daemon, no build step.** We adopt agentmemory's
   *capabilities* (auto capture, hybrid search, MCP surface) without
   its *operational profile* (separate Rust binary, persistent server,
   tsdown build, multi-package monorepo).

---

## 3. Capture Layer (Hooks)

### 3.1 Hook tier classification

| Hook | Trigger | `source_kind` in events | Tier |
|---|---|---|---|
| `SessionStart` | new session | `hook-session-start` | **1** |
| `UserPromptSubmit` | user submits prompt | `hook-user-prompt` | **1** |
| `PostToolUse` | tool returns (success) | `hook-post-tool-use` | **1** (main signal) |
| `PostToolUseFailure` | tool fails | `hook-tool-failure` | **1** |
| `PreCompact` | context compaction imminent | `hook-pre-compact` | **1** |
| `SessionEnd` | session ends | `hook-session-end` | **1** |
| `Stop` | turn complete | `hook-assistant-stop` | 2 |
| `SubagentStart` / `SubagentStop` | subagent lifecycle | `hook-subagent-*` | 2 |
| `TaskCompleted` | TodoWrite completion | `hook-task-completed` | 2 |
| `Notification` | host notification | `hook-notification` | 2 |
| `PreToolUse` | tool about to run | `hook-pre-tool-use` | 3 (deferred) |

**v0.3.0 ships Tier-1 (6 hooks).** Tier-2 in v0.3.x follow-ups,
Tier-3 deferred indefinitely (`PreToolUse` overlaps with `PostToolUse`
on usable signal).

Codex CLI's supported lifecycle subset
(`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse`
/ `PreCompact` / `Stop`) covers Tier-1 minus `PostToolUseFailure`
and `SessionEnd`. Codex Desktop has a known plugin-hook silent issue
([openai/codex#16430](https://github.com/openai/codex/issues/16430));
we ship an analogous `agentmemory connect codex --with-hooks` style
opt-in mirror to user-scope `~/.codex/hooks.json` as a fallback.

### 3.2 Hook script flow

```
host stdin (JSON event)
        │
        ▼
scripts/hooks/<hook-name>.mjs   (bundled, run via ${CLAUDE_PLUGIN_ROOT}/…)
        │
        │  0. **(R4-D)** read `~/.deep-memory/config.yaml#capture.enabled` —
        │     if FALSE: exit 0 immediately (no stdin read, no disk write,
        │     no events.jsonl append). Cache the value with mtime check
        │     to avoid disk read per hook (in-memory cache invalidated
        │     when config.yaml mtime changes). Without this gate, hooks
        │     registered in the manifest would append even when the user
        │     opted out — closes R4-D privacy bypass.
        │  1. read stdin, validate basic shape (ajv schema per hook)
        │  2. Pass 0 redact (rule-based — strictest ruleset; capture-time)
        │  3. compute event_key = sha256(envelope + payload essence)
        │     compute dedupe_window_key = sha256(essence) for 5-min slide
        │  4. normalize → standard event shape (§3.4)
        │  5. atomic append to ~/.deep-memory/events/YYYY-MM.jsonl
        │     — **short critical section** (~ms order):
        │       acquire .lock → fsync write → release .lock
        │       (this is the SAME mkdir-based .lock as distill, but the
        │        critical section here is bounded to one fsync+rename;
        │        see §4.5 for the matching split on the distill side)
        │  6. if hook ∈ {SessionEnd, PreCompact} AND
        │       config.capture.eager_distill == true:
        │     enqueue distill job — detach + unref child (see §3.2.1)
        │
        ▼
events.jsonl  (append-only, dedup'd)
```

**Hard invariants** (hook scripts):
- do **not** call LLMs.
- do **not** open network connections.
- do **not** spawn subprocesses except the optional fire-and-forget
  distill job (see §3.2.1).
- hold the global `.lock` for **at most one fsync+rename** (~ms),
  never across an LLM/embedding call (those live in §4.5 distill,
  outside the lock).
- return within the hook latency budget regardless of child state.

#### 3.2.1 Fire-and-forget child-process invariants

When `config.capture.eager_distill: true` and `SessionEnd` or
`PreCompact` fires, the hook spawns a distill worker. The following
invariants prevent lock/lease leaks across host shutdown and rapid
back-to-back hook fires:

| # | Invariant | Mechanism |
|---|---|---|
| 1 | Child must detach from parent process group | `node child_process.spawn({ detached: true })` + `child.unref()` so the parent hook can exit immediately |
| 2 | Hook returns within latency budget regardless of child state | Spawn is synchronous; hook returns 0 immediately after `unref()`. Child's lease/lock acquisition happens *in the child*, not in the hook. |
| 3 | Child writes a heartbeat into `.leases/<project_id>.lease` | Lease record gains `{pid, host, started_at, last_heartbeat_at}` field. Child updates `last_heartbeat_at` every 30 s while alive. |
| 4 | Stale lease detection extends to heartbeat freshness | Existing 5-min mkdir lock stale-window stays. Additionally, `.leases/<project_id>.lease` with `last_heartbeat_at` older than 60 s is treated as stale and removable by `/deep-memory-audit --unlock`. |
| 5 | Back-to-back hook fires (PreCompact then SessionEnd within < 1 s) coalesce | Second hook checks lease freshness: if `now - last_heartbeat_at < 30 s`, the child is presumed running and the second hook skips spawn (logs "distill already in flight"). |
| 6 | `--unlock` recovery explicitly covers orphaned distill children | `/deep-memory-audit --unlock` scans `.leases/` for stale heartbeats AND `.lock` mkdir-stale together. Both cleaned in one pass. |

Acceptance test (added to §12 list): "PreCompact + SessionEnd fired
within 1 s on a project leaves at most one distill child running,
and `.lock` / `.leases/` are clean within 60 s of session exit."

#### 3.2.2 Hook latency budget — empirical gate before β-phase

Spec target: < 500 ms p95 per hook invocation under realistic load
(PostToolUse fires every tool call, typical session has 30–50 calls
in 60 s). Pass 0 = ajv schema validate + 2× sha256 (event_key +
dedupe_window_key) + N regex sweeps + atomic append under .lock.
The 500 ms p95 target is plausible but **unverified by analytic
budget alone**.

**Early prototype gate** (moved here from §15 Open Questions Q4 —
this is now a release-blocking gate, not a plan-phase question):

| Gate | Phase | Pass criterion |
|---|---|---|
| **G-α-latency** | end of Phase 0.3.0-α (hooks-only landing) | macrobenchmark: 30 sequential PostToolUse fires from a recorded session fixture, p95 ≤ 400 ms (= budget − 20 % headroom). If p95 > 400 ms, redesign before β: async append to in-memory buffer + flush every 30 s + on hook exit. **Fixture spec (R2-N)**: 30-event sequence recorded from a real Edit-heavy refactor session, mean `payload.raw_chars_out` = 2 048, p95 = 8 192. Committed to `tests/fixtures/hooks/g-alpha-macro.jsonl`. Without an explicit fixture, a contributor could trivially pass the gate by using 100-char tool outputs that don't exercise Pass 0 redaction at realistic size. |
| **G-β-latency** | end of Phase 0.3.0-β (Lazy distill landing) | same macrobenchmark but with one concurrent `/deep-memory-brief` call mid-stream, p95 ≤ 500 ms (= full budget; distill must not block hooks via lock contention — verifies §4.5 lock split is effective). |

Both gates run as part of `npm test` under a `LATENCY=1` env flag.
Failure blocks merging the phase PR.

### 3.3 Pass 0 redaction (capture-time, new)

The existing 3-pass redaction (Step A input / Step B input / envelope
wrap) becomes **4-pass** in v0.3.0:

| Pass | When | Input |
|---|---|---|
| **Pass 0 (NEW)** | hook stdin → `events.jsonl` (capture-time) | raw host hook payload |
| Pass 1 | Step A mapper input | events bundle |
| Pass 2 | Step B (LLM) input | event-draft |
| Pass 3 | envelope wrap (disk commit) | LLM-refined card |

All passes use the **same rule set** in `scripts/lib/redact.js` (single
source of truth). Pass 0 sees the most raw content but the ruleset is
applied uniformly — there is NO Pass-0-only rule. The full shared rule
set in v0.3.0:

- **Existing (v0.1.x)** — applied at all passes:
  - API key patterns (AWS / OpenAI / Anthropic / Google / Stripe / GitHub)
  - JWT / OAuth bearer tokens
  - SSH private key prefixes (`-----BEGIN ...PRIVATE KEY-----`)
  - `<private>…</private>` envelope tags (removed wholesale)
  - User-defined `suppressions.yaml` patterns
- **Promoted to shared in v0.3.0** (response to R-011 — these were
  originally Pass-0-only; v0.3.0 promotes them so MCP `deep_memory_save`
  and slash skill inputs also benefit):
  - File-path normalization (`/Users/<u>/...` → `~/…`)
  - Environment variable substitution (`$AGENTMEMORY_SECRET`, `$AWS_*`,
    `$ANTHROPIC_*`, `$OPENAI_*`, etc. masked to `$<VAR>=<REDACTED>`)
  - Stack trace home-dir redaction (extending v0.1.3's `redactString`
    to cover multi-line stacks)

**Why uniform application matters**: an agent calling
`deep_memory_save` could otherwise leak `/Users/sungmin/...` paths or
environment-variable values that hook capture would have stripped.
Promoting these three rules to the shared set closes that asymmetry
and matches the v0.1.3 invariant that "all warnings pass through
`redactString`". The rule set is defined once in `scripts/lib/redact.js`
and consumed by every pass — no "Pass 0 extra" branch.

### 3.4 Hook event schema (new — separate file, separate artifact_kind)

**Decision (response to R-001 / R-002 / R-009)**: hook events use a
**new schema file** `schemas/memory-hook-event.schema.json` with
`artifact_kind: "memory-hook-event"`, leaving the existing
`schemas/memory-event.schema.json` (with its strict
`additionalProperties: false`, `event_kind` enum
`{harvested|merged|promoted|demoted}`, and required
`event_key|source_artifact_id|event_kind|cards_count|at`) **untouched**.
Both record types co-exist in `events/YYYY-MM.jsonl`, one per line,
discriminated by `envelope.artifact_kind`. This eliminates the
field-name collision between hook capture vocab (`source_kind`) and
state-machine vocab (`event_kind`) — they live in different artifact
schemas. The v0.1.x `memory-event` schema remains the authority for
state-machine transitions (harvest/merge/promote/demote audit trail);
the new `memory-hook-event` schema is the authority for raw capture.

#### 3.4.1 Discriminator model (dual vocab, non-overlapping)

| Field | Vocabulary | Artifact_kind | Purpose |
|---|---|---|---|
| `event_kind` | `harvested\|merged\|promoted\|demoted` | `memory-event` (existing) | State-machine transition log for cards |
| `source_kind` | `hook-session-start\|hook-user-prompt\|hook-post-tool-use\|hook-tool-failure\|hook-pre-compact\|hook-session-end` | `memory-hook-event` (new) | Raw hook-capture channel discriminator (hook-only by design — see §3.4.2 naming explanation; slash `/deep-memory-remember`, MCP `deep_memory_save`, and `/deep-memory-harvest --source siblings` do NOT emit `memory-hook-event` records) |

A single physical line in `events/YYYY-MM.jsonl` has **exactly one**
of these discriminators (chosen by `envelope.artifact_kind`). Readers
ajv-validate against the appropriate schema for the line's
`artifact_kind`. There is no field name collision because
`source_kind` does not appear in `memory-event` payloads and
`event_kind` does not appear in `memory-hook-event` payloads.

#### 3.4.2 `memory-hook-event` record shape

```json
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-memory",
    "producer_version": "0.3.0",
    "artifact_kind": "memory-hook-event",
    "run_id": "01J0XKMRWQ7B9YZ8AE6F3VHTN5",
    "generated_at": "2026-05-22T07:14:32.811Z",
    "schema": { "name": "memory-hook-event", "version": "1.0" },
    "git": { "head": "<sha>", "branch": "<name>", "dirty": "<flag>" },
    "provenance": {
      "source_artifacts": [
        { "path": "host-stdin://claude-code/PostToolUse" }
      ],
      "tool_versions": { "node": "<version>" }
    },
    "host": "claude-code",
    "session_id": "claude-cc-7a3f...",
    "project_id": "proj_8e2c..."
  },
  "payload": {
    "source_kind": "hook-post-tool-use",
    "event_key": "<sha256 hex, 64 chars>",
    "dedupe_window_key": "<sha256 hex, 64 chars>",
    "captured_at": "2026-05-22T07:14:32.811Z",
    "tool_name": "Edit",
    "tool_input_summary": "edited src/auth.ts (12 lines)",
    "tool_output_summary": "...",
    "raw_chars_in": 4321,
    "raw_chars_out": 1024,
    "redaction": { "rules_matched": 1, "chars_masked": 18, "passes": ["pass0"] }
  }
}
```

Required fields, types, and `additionalProperties: false` are
codified in `schemas/memory-hook-event.schema.json` (added in Phase
0.3.0-α).

**Envelope shape relationship to `memory-event.schema.json`**
(round-2 R2-I clarification): the new schema is **NOT a strict
subset** of the existing v0.1.x `memory-event` schema — it adds three
envelope fields (`host`, `session_id`, `project_id`) beyond the
v0.1.x envelope set. M3 invariants are preserved **on the shared
fields**:

- `producer` const `"deep-memory"`
- `producer_version` SemVer 2.0.0 pattern
- `artifact_kind` const `"memory-hook-event"` (new value;
  `memory-event` schema's `artifact_kind` const remains
  `"memory-event"` — two const values, one per schema)
- `run_id` ULID format
- `generated_at` RFC 3339 format
- `schema.name` + `schema.version` (object with required name+version)
- `git` (head/branch/dirty triplet — same shape)
- `provenance.source_artifacts[]` (path required, run_id optional)

The three new envelope fields (`host`/`session_id`/`project_id`) are
**envelope-level on purpose** — they are capture-context provenance
(analogous to how `git.head` is envelope-level), not payload data.
Promoting them to `envelope.additionalProperties` is the explicit
design choice; the schema declares them as required fields with
their own validators.

**Artifact_kind naming** (round-2 R2-I sub-issue): the name
`memory-hook-event` is **hook-specific by design**. Other capture
channels route through the existing schemas:

- **`/deep-memory-remember`** (slash + MCP `deep_memory_save`):
  produces a fully-formed *memory-card* directly (skipping the event
  layer entirely). Goes to `cards/<type>/<proj>/` via `scripts/save.js`.
  No `events.jsonl` entry; the card's `payload.deep_memory_provenance[]`
  records origin = `"explicit-save"`.
- **`/deep-memory-harvest --source siblings`**: sibling artifact
  scan produces `memory-event` records with `event_kind: "harvested"`
  in the existing v0.1.x format. No `memory-hook-event` involvement.

Therefore `source_kind` enum is **hook-only**:
`hook-session-start | hook-user-prompt | hook-post-tool-use |
hook-tool-failure | hook-pre-compact | hook-session-end`. The earlier
draft enum that included `skill-remember`/`mcp-save`/`sibling-harvest`
was an over-extension — those channels don't generate `events.jsonl`
records at all (slash/MCP save → cards directly; sibling harvest →
`memory-event` not `memory-hook-event`). The §3.4.1 dual-discriminator
table reflects this correction.

#### 3.4.3 `distilled` flag — removed in favor of byte-offset cursor

The original draft included a `payload.distilled: false` flag intended
to be flipped to `true` after distill. That contradicted the
append-only invariant. **Decision**: no `distilled` field on disk.
Distill progress is tracked via a **byte-offset watermark file**
`.last-distill-cursor/<project_id>` (not a timestamp).

**Why byte offset, not timestamp** (round-2 R2-B unanimous): a
timestamp-only watermark fails on three identifiable cases:

1. **Same-timestamp skip**: two events with identical
   `payload.captured_at` (ms precision); first processed → cursor
   advances past the timestamp → second event's `captured_at == cursor`
   never satisfies strict `>`. Skipped forever.
2. **Token-cap deferral skip**: when `distill.max_llm_tokens_per_run`
   defers part of a batch, advancing cursor to `max(captured_at)` of
   processed events leaves any deferred event with the same timestamp
   unreachable on the next run.
3. **Non-chronological session grouping skip**: §4.5 Stage 2 groups
   by session_id; processing a later-timestamped session first and
   advancing the cursor regresses or skips earlier-timestamped events
   from another session in the same batch.

Byte offset has a natural total order on an append-only file and
sidesteps all three.

**Cursor file format**:
```
<YYYY-MM>.jsonl:<byte_offset>
```
e.g. `2026-05.jsonl:184320`. One file per project. The filename
component handles month rollover (the next month gets cursor
`2026-06.jsonl:0`).

**Cross-month rollover (R3-K clarification)**: if the cursor's
`<YYYY-MM>.jsonl` is the current month, Stage 1b reads
`[cursor_offset, current_byte_size)` of that single file. If the
cursor is on a past month, Stage 1b reads:
1. `[cursor_offset, EOF)` of the cursor's month file
2. ALL bytes of every intervening month file (older→newer, lex-sortable
   filenames)
3. `[0, current_byte_size)` of the current month file

Stage 6 advance after processing a cross-month batch: cursor advances
into the latest fully-processed file's byte offset (e.g. if the batch
spanned May+June and ended mid-June, cursor becomes `2026-06.jsonl:NNN`).
The May file's bytes are implicitly "fully processed" once cursor is
in a later file.

**Archived (gzipped) month files (R3-K)**: v0.3.0 does **NOT**
support archived/compressed `events/*.jsonl.gz` files for distill
purposes. If the cursor's month file is no longer present (filename
doesn't match `YYYY-MM.jsonl` exactly — e.g. has been gzipped to
`YYYY-MM.jsonl.gz` or moved to an archive directory), the Lazy
distill aborts with:
- `warnings[]` entry: `"Cursor's events file (<filename>) is archived
  or missing. Run /deep-memory-audit --reset-cursor=<new-position> to
  recover, or restore the file."`
- Brief continues with whatever is already in the index (no new
  distill, no crash).

Archive support is **deferred to v0.3.x** (recorded as §15 plan-phase
open question — events.jsonl rotation/archive strategy for long-running
users).

**Stage 1 query** (replaces §4.5 wording): "read lines from the
cursor's `<file>:<offset>` forward; for cross-month rollover, also
read all of `<file>.next` and any subsequent month files up to
current month's tail." The cursor scan is in §4.5 Stage 1's short
critical section A (lock-protected snapshot of file size, then
lockless tail read).

**Stage 6 advance**: cursor advances to the byte offset immediately
after the LAST FULLY-COMMITTED line (not the max byte across the
batch — token-cap deferral leaves intermediate lines unprocessed;
cursor advances ONLY past lines whose cards were atomically written +
indexed). Deferred lines remain "before the cursor advance" from the
next run's perspective and are picked up automatically.

**Edge case (sub-batch duplicate event_key)**: if a hook race
produces two `event_key`-identical lines in the same batch, the
in-memory dedupe set still filters the second within the batch. The
byte cursor doesn't change this — only the index-side dedupe applies.

**Migration note** (for any v0.3.0-α implementation that started
with timestamp cursor): rewrite the cursor file format on init.js
upgrade. Old format `2026-05-22T07:14:32.811Z` → new format derived
by scanning forward from the start of the current month's file until
finding the first line with `captured_at > old_timestamp`, then
recording that line's byte offset. One-time, idempotent.

#### 3.4.4 Backward compatibility + legacy flat-event adapter (R3-G fix)

- `memory-event` schema: untouched. v0.1.x readers (harvest.js,
  audit.js, retrieve.js) keep working without code change.
- `memory-hook-event` schema: new file. v0.3.0+ harvest.js gains an
  artifact_kind dispatcher: read a line → peek `envelope.artifact_kind`
  → route to validator.
- `events/YYYY-MM.jsonl` is **format-mixed by line** but each line is
  independently valid against its declared schema.

**Legacy flat-event adapter (R3-G — round-3 Codex adversarial MEDIUM)**:
the actual `scripts/harvest.js` in v0.1.x writes flat event records
directly at the top level (with `event_key`/`source_artifact_id`/
`event_kind`/`cards_count`/`at` at the root), NOT wrapped in
`{schema_version, envelope, payload}`. Validating these against
`memory-event.schema.json` (which REQUIRES the envelope/payload wrap)
would quarantine real legacy event logs instead of preserving them.

The v0.3.0 dispatcher therefore implements a **runtime adapter**:

```
dispatcher(line):
  obj = JSON.parse(line)
  if 'envelope' in obj and 'payload' in obj:
      # v0.3.0+ shape — route by envelope.artifact_kind
      if obj.envelope.artifact_kind == 'memory-event':
          validate against memory-event.schema.json
      elif obj.envelope.artifact_kind == 'memory-hook-event':
          validate against memory-hook-event.schema.json
      else:
          route to .quarantine/ (unknown artifact_kind)
  elif {'event_key', 'at', 'cards_count'}.issubset(obj.keys()):
      # legacy flat v0.1.x shape — wrap in envelope/payload at read time.
      # R4-H correction: real harvest.js writes {event_key, source, run_id,
      # at, cards_count, project_id} flat — NOT event_kind / source_artifact_id
      # (those are NEW schema-required fields v0.1.x didn't emit). The
      # discriminator triplet {event_key, at, cards_count} matches the actual
      # v0.1.x record set without requiring fields v0.1.x never wrote.
      adapter_envelope = synthesize_envelope_from_flat(obj)
      synthesized = {
        'schema_version': '1.0',
        'envelope': adapter_envelope,  # producer/run_id/etc. inferred
                                       # or marked synthetic-v0.1.x
        'payload': normalize_legacy_payload(obj)  # maps {source → source_artifact_id},
                                                  # defaults event_kind = 'harvested'
                                                  # (legacy events were always harvest-result)
                                                  # for memory-event.schema.json compliance
      }
      validate against memory-event.schema.json
  else:
      route to .quarantine/ (unparseable / missing required keys)
```

The adapter is **runtime-only** (no disk migration). Old flat events
stay on disk in their original shape; the adapter wraps them on
read. v0.1.x readers continue reading the same flat shape they
always have. v0.3.0+ readers see the wrapped shape uniformly.

§9.1 test plan adds: fixture `tests/fixtures/legacy/v01x-flat-event.jsonl`
copied from real v0.1.x harvest output; dispatcher test asserts
adapter wraps it correctly and it passes `memory-event.schema.json`
validation. §12 acceptance R2-M-2 updated to reference the adapter
(line previously said "validated against `memory-event.schema.json`"
— now says "passed through legacy adapter then validated").

### 3.5 Hook registration (manifest)

`.claude-plugin/plugin.json` additions:

```json
{
  "name": "deep-memory",
  "version": "0.3.0",
  "hooks": {
    "SessionStart":       [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.mjs"}]}],
    "UserPromptSubmit":   [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/user-prompt-submit.mjs"}]}],
    "PostToolUse":        [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-use.mjs"}]}],
    "PostToolUseFailure": [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-failure.mjs"}]}],
    "PreCompact":         [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.mjs"}]}],
    "SessionEnd":         [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-end.mjs"}]}]
  },
  "mcpServers": { "...": "see §6" }
}
```

`.codex-plugin/plugin.json` registers the **4 Codex-supported hooks**
of Tier-1 (`SessionStart` / `UserPromptSubmit` / `PostToolUse` /
`PreCompact`). `PostToolUseFailure` and `SessionEnd` are Claude-Code
only, so they are skipped on the Codex side — `mapHookSession` already
treats their absence as zero-event input, so session-summary distill
still works on Codex (just based on `PreCompact` + lazy `/deep-memory-brief`
trigger instead of `SessionEnd`). `matcher` field is omitted per
Codex's hook schema.

### 3.6 User-visible behavior

- **Fresh install** (new `~/.deep-memory/`): first slash invocation
  (typically `/deep-memory-init` or `/deep-memory-brief`) prompts
  the user once: "Enable automatic hook capture? (records tool use
  to `~/.deep-memory/events/` — see §3.3 for redaction policy.)
  [Y/n, default N]". Choice is recorded in `audit-log/YYYY-MM.jsonl`
  with method=`prompted` and persisted to `config.yaml#capture.enabled`.
- **Upgrade from v0.2.x** (existing `~/.deep-memory/` migrated by §8.1):
  `capture.enabled` defaults to **`false`** — no silent enablement of
  always-on capture on an existing user. The next slash invocation
  surfaces "Auto-capture is currently OFF (default for v0.3.0
  upgrades). Run `/deep-memory-init --enable-capture` to opt in."
- **MCP-spawned init** (no terminal — see §8.1 isatty gate): never
  prompts; defaults `capture.enabled: false` with a `warnings[]`
  entry surfaced via `latest-distill.warnings` and the
  `deep-memory://status` resource.
- Once enabled, `~/.deep-memory/events/` fills automatically.
  `/deep-memory-brief "<task>"` triggers Lazy distill of unprocessed
  events then returns the brief.
- `/deep-memory-harvest` retains its sibling-artifact role (now
  secondary; siblings-only in standalone use). Hook-events ingestion
  is exclusively via Lazy / Eager triggers (§4.3); the
  `--source hooks` arg from the original draft is removed — there
  is no separate "harvest hook events" path, those flow through the
  distill triggers automatically.
- `~/.deep-memory/config.yaml` gains `capture.enabled` (default policy
  above), `capture.eager_distill: false` (always opt-in), and the
  per-detector + retrieval keys listed in §4.2 / §4.6 / §5.6.
- Every `capture.enabled` toggle (true→false or false→true, regardless
  of trigger: prompt, CLI flag, MCP, audit) appends an entry to
  `audit-log/YYYY-MM.jsonl` per the §6.3.1 uniform envelope:
  `{at, id, kind: 'capture-toggle', by: 'slash-direct'|'cli-flag'|'init-migration',
  host, payload: {from: bool, to: bool, method: 'prompted'|'cli-flag'|'non-interactive-default'}}`
  — visible via `deep-memory://audit/last` MCP resource. R4-E ensures
  this entry shape matches `schemas/audit-log-entry.schema.json` so all
  audit-log writers (capture-toggle here, mutation-consent in §6.3.1,
  migration init in §8.1) emit envelope-conformant entries.

---

## 4. Distill Layer (extended)

### 4.1 Step A mappers (5 unchanged + 1 new)

| # | Mapper | Source | Output `memory_type` | Change |
|---|---|---|---|---|
| 1 | `mapRecurringFindings` | deep-review sibling | `pattern` / `failure-case` | unchanged |
| 2 | `mapEvolveInsights` | deep-evolve sibling | `experiment-outcome` | unchanged |
| 3 | `mapWorkReceipt` | deep-work sibling | `architecture-decision` | unchanged |
| 4 | `mapDocsScan` | deep-docs sibling | `coding-style` / `failure-case` | unchanged |
| 5 | `mapWikiIndex` | deep-wiki sibling | `pattern` | unchanged |
| **6** | **`mapHookSession`** | **hook-* events bundled by `session_id`** | **all 5 types (rule-based dispatch)** | **NEW** |

### 4.2 `mapHookSession` internal detectors (rule-based, deterministic)

```
mapHookSession(sessionEvents[]) → event-drafts[]
  │
  ├─ patternDetector(events)      — same tool-sequence repeated ≥2 times → pattern draft
  ├─ failureDetector(events)      — PostToolUseFailure followed by fix (Edit/Bash retry) → failure-case draft
  ├─ decisionDetector(events)     — multi-file edit (≥3 files in one prompt) OR architecture-impact tool → architecture-decision draft
  ├─ styleDetector(events)        — repeated naming/format pattern in Edit ops → coding-style draft
  └─ sessionSummary(events)       — fallback: 1 architecture-decision per session (preserves session meaning)
```

Detector heuristics are deterministic (no LLM in Step A). Each detector
emits 0..N drafts. Zero output is valid (means: no meaningful pattern
in this session).

Detector thresholds live in `config.yaml#distill.detectors`:
```yaml
distill:
  detectors:
    pattern:
      min_repetitions: 2
      sequence_window: 5
    failure:
      retry_window_events: 3
    decision:
      min_files_changed: 3
    style:
      min_pattern_matches: 3
    session_summary:
      always_emit: true   # set false to skip fallback
```

### 4.3 Distill triggers (3 modes)

| Trigger | When | Scope | Notes |
|---|---|---|---|
| **Lazy** (default) | start of `/deep-memory-brief` if unprocessed events exist | all unprocessed events for current project | Most common path; no LLM cost unless user actually asks for a brief |
| **Eager (hook)** | `SessionEnd` / `PreCompact` hook fires, **only if** `config.capture.eager_distill: true` | current session events | Fire-and-forget child process; never adds hook latency |
| **Explicit** | `/deep-memory-harvest [--source siblings\|all] [--session <id>]` | per arg | CI / manual ops. `--source` enum = `siblings` (sibling artifacts only) or `all` (siblings + force re-distill of unprocessed hook events, ignoring cursor). The `hooks` value from the original draft is removed (R-014) — hook-only distill is always-on via Lazy/Eager and does not need a separate manual path. `--rebuild-from-events` is the explicit retroactive re-distill flag for hook events already past the cursor. |

Lazy is the safe default — no LLM cost unless the user actively asks
for memory, no background CPU surprise. Eager is opt-in for users
who want briefs always up-to-date at session boundaries.

### 4.4 Step B batch refine (new)

Existing `llm-bridge.refine(draft)` does 1 LLM call per draft. With
hook capture producing 5–15 drafts per session, that's a cost
amplifier. v0.3.0 adds:

```js
// scripts/lib/llm-bridge.js
llm-bridge.refineBatch(drafts: Draft[], opts) → RefinedCard[]
```

- Bundles up to `config.distill.batch_size` (default 5) drafts per LLM call.
- Response schema: `{ drafts: RefinedCard[] }` — schema-validated with
  ajv strict mode (same as v0.1.x single-draft).
- If batch response has 1 schema-violating draft, only that draft
  falls back to Step A candidate; other drafts in the batch are
  preserved.
- Sub-agent prompt (`agents/memory-distiller.md`) updated to handle
  batch input. Existing single-call recorded fixtures stay.

### 4.5 Full distill pipeline (Lazy trigger path)

**Lock-granularity invariant (R-004)**: the global `.lock` is acquired
in **two short critical sections**, never across the LLM/embedding
work. LLM `refineBatch()` (network-bound, multi-second) and embedding
cold load (~500-1000 ms) happen **outside** the lock. Hook append
(§3.2 step 5) and any other concurrent reader/writer are blocked only
during the bounded fs commit, not during LLM/embed.

```
/deep-memory-brief "<task>"
       │
       ├─ Stage 0:  project lease acquire (file-level lease, separate from global lock)
       │
       ├─ Stage 1a: short critical section A — snapshot cursor + file size
       │              acquire .lock
       │              → read `.last-distill-cursor/<proj_id>` (format `<file>:<offset>`)
       │              → stat current month's events file → record current_byte_size
       │              → release .lock                                  (~µs order — no line reads under lock)
       │
       ├─ Stage 1b: LOCKLESS tail read — append-only file is safe to read past cursor
       │            pending = bytes [cursor_offset, current_byte_size) of cursor's file,
       │                      + all of any newer-month files (rollover) up to current tail
       │            seen_keys = set of event_keys observed in this batch (in-memory dedupe)
       │            note: lines appended AFTER current_byte_size snapshot are next batch,
       │                  not this batch — append-only invariant makes this race-free
       │
       ├─ Stage 1c (R4-C — cross-project filter):
       │            filter pending events to envelope.project_id == current_project_id
       │            BEFORE grouping. events.jsonl is global (one file across all
       │            projects per §7); this project's brief MUST only process this
       │            project's events. Other-project lines are silently ignored for
       │            THIS project's cursor advance (they'll be picked up by THEIR
       │            project's next brief — each project has its own
       │            .last-distill-cursor/<proj_id> watermark).
       │            **Implementation note**: lines without envelope.project_id
       │            (legacy/malformed) are routed to .quarantine/ same as the
       │            §3.4.4 dispatcher quarantine path.
       │
       ├─ Stage 2:  group filtered (current-project) pending events by session_id
       │                                                  (in-memory, no lock)
       │
       ├─ Stage 3:  per-session, run Pass 1 redact → mapHookSession() → drafts[]
       │              (deterministic Step A — no LLM)
       │
       ├─ Stage 4:  refineBatch(drafts) → refined_cards   (LLM call — outside .lock)
       │              (Pass 2 redact input, Pass 3 redact + envelope wrap output)
       │              Step B failure on a draft → candidate fallback (v0.1.x)
       │
       ├─ Stage 5:  (if @xenova available) compute vector embeddings for each card
       │              (outside .lock — cold load ~500-1000 ms first time)
       │
       ├─ Stage 6:  short critical section B — commit + advance cursor
       │              acquire .lock
       │              → for each draft processed in order of original line position:
       │                  - dedupe by dedupe_key + content_hash (against cards/ on disk):
       │                    same dedupe_key + same content_hash → no-op (idempotent re-run)
       │                    same dedupe_key + different content_hash → last-writer-wins
       │                       on BOTH file and indexes (atomic replace; consistency
       │                       maintained — see §4.5 optimistic concurrency block)
       │                  - atomic write cards/<type>/<proj>/<id>.json
       │                  - FTS5 upsert (lexical.sqlite)
       │                  - vector upsert (vector.sqlite)              (~10-100 ms order)
       │              → advance .last-distill-cursor/<proj_id> to the byte offset
       │                IMMEDIATELY AFTER the last PROCESSED line (whether or not
       │                the line produced a card — R3-F fix: zero-draft lines are
       │                still 'processed', else mapHookSession's allow-zero-output
       │                semantics cause infinite reprocess loop).
       │                **'Processed' (R4-B corrected definition)** = Step A
       │                mappers were applied to the line AND any resulting drafts
       │                were either COMMITTED via this Stage 6 OR explicitly
       │                ZERO-DRAFT (no card emitted by any detector). **Token-cap
       │                deferred drafts do NOT count as 'processed'** — the line
       │                whose draft was deferred stays BEFORE the cursor so it
       │                will be re-attempted on the next brief.
       │                Implementation: advance cursor to the byte offset of the
       │                LAST CONTIGUOUS processed-or-zero-draft line; the first
       │                token-cap-deferred line and everything after it stays
       │                pending. NOT max byte across batch.
       │              → release .lock
       │
       ├─ Stage 7:  release project lease
       │
       └─ (Stage 8 lazy invocation is described in §5.1 Stage 0a —
            brief format consumes the now-committed index)
```

**Optimistic concurrency** (race between two concurrent briefs):
- Both briefs may scan the same `events.jsonl` window in Stage 1a/1b.
- **Pre-LLM dedupe gate (round-2 R2-J fix)**: just before calling
  `refineBatch()` in Stage 4, each brief re-acquires critical section
  A briefly, checks whether any card with the prospective `dedupe_key`
  has been committed by a peer in the meantime (peek `cards/<type>/<proj>/`
  directory). If yes for *all* drafts in the batch, brief skips Stage 4
  entirely (LLM cost saved). If yes for *some* drafts, those are
  removed from the batch (saving partial LLM cost). If brief A is in
  critical section B at the moment brief B attempts this re-acquire,
  brief B blocks for the duration of A's commit (~10-100 ms order);
  this is by design — the gate's purpose is to read the latest
  committed peer state (R3-L clarification).
- **Stage 6 tiebreaker** (round-2 R2-J fix): cards have a
  `content_hash` field (sha256 of `payload.claim + applicability +
  recommended_action`). Dedupe rule: same `dedupe_key` + same
  `content_hash` → idempotent no-op (re-run safe). Same `dedupe_key`
  + DIFFERENT `content_hash` (non-deterministic LLM output) →
  last-writer-wins atomically: replace card file AND replace FTS5
  row AND replace vector row, all under critical section B. The
  file and indexes stay consistent — never split-brain where index
  points to text disagreeing with disk.
- **Cursor advance is monotonic per file**: brief B's commit
  advances cursor to its last-committed byte offset only if that
  offset is GREATER than brief A's advanced cursor. If both committed
  identical prefixes, second advance is a no-op.
- FTS5/vector upserts are by `memory_id` — atomic-replace under
  the same critical section as file write.

This makes the pipeline safe for two concurrent briefs while still
allowing recovery from LLM non-determinism (last-writer-wins is
deterministic given the same disk + lock ordering). The
`refineBatch` token budget (§4.6) bounds the duplicated work.

**LLM-cost-conscious deferral**: if Stage 4 hits
`distill.max_llm_tokens_per_run`, remaining drafts are NOT processed
and the cursor in Stage 6 advances only to the **byte offset
immediately after the last contiguous processed line** (matches
Stage 6's byte-offset contract — NOT `captured_at`, which §3.4.3
rejects as lossy). Deferred lines remain reachable on next run by
virtue of cursor being upstream of them. No events are skipped.

### 4.6 LLM cost management

| Knob | Default | Effect |
|---|---|---|
| `distill.max_drafts_per_session` | 10 | Caps per-session draft count to avoid runaway sessions |
| `distill.max_llm_tokens_per_run` | 50000 | Per-invocation token ceiling; excess drafts deferred to next run |
| `distill.batch_size` | 5 | Drafts bundled per LLM call |
| `distill.detectors.*.always_emit` | varies | Tunable per detector |

`llm-bridge.on_failure: candidate` (existing v0.1.x policy) carried
forward unchanged — Step B failure preserves the Step A draft as a
candidate card with lower confidence.

### 4.7 4-tier metaphor mapping (documentation overlay only)

| agentmemory tier | deep-memory artifact | On-disk location |
|---|---|---|
| **Working** | hook-captured raw observation | `events/YYYY-MM.jsonl` |
| **Episodic** | session-summary `architecture-decision` card | `cards/architecture-decision/<proj>/session_*.json` |
| **Semantic** | `pattern` / `failure-case` / `experiment-outcome` / `coding-style` cards | `cards/<type>/<proj>/mem_*.json` |
| **Procedural** | card's `payload.recommended_action[]` field | (within Semantic/Episodic cards) |

This is a **documentation overlay**. The schema, file layout, and
codepaths are unchanged. README and `agents/memory-distiller.md`
explain the mapping for users who arrive from agentmemory
vocabulary.

---

## 5. Retrieval Layer (FTS5 + Vector + RRF)

### 5.1 Pipeline diagram

```
query string
   │
   ├─ Stage 0a: **Lazy distill gate (R-003 — runs BEFORE candidate gen)**
   │            if any unprocessed events exist (cursor check vs.
   │            events.jsonl tail in §3.2 critical section A):
   │                → run §4.5 distill pipeline to commit new cards
   │                  + FTS5/vector upsert + cursor advance
   │                → only then proceed to Stage 0b
   │            (this is what makes "first brief in zero-sibling env
   │             returns memory" actually work — §12 acceptance)
   │
   ├─ Stage 0b: parse query + compute embedding
   │            (FTS5 tokens for lexical; 384-dim Float32 for vector)
   │
   ├─ Stage 1 (parallel):
   │     ├─ FTS5 BM25 → top-K candidates (K=30 default)
   │     │     WHERE privacy_level = 'global' OR project_id = <current_project_id>
   │     │       AND status IN ('validated','candidate')
   │     │     (v0.1.x FTS5 schema uses `privacy_level` and `project_id`
   │     │      columns directly — NOT a single `privacy_level` field
   │     │      and NOT a `status` column. The actual FTS5 schema is in
   │     │      scripts/lib/fts-index.js and stays unchanged in v0.3.0.
   │     │      `status` filter is applied post-FTS in JS via the
   │     │      6-stage rerank Stage 3, since FTS5 contentless indexes
   │     │      don't carry the status enum.)
   │     │
   │     └─ Vector cosine → top-K candidates (K=30)
   │           WHERE privacy_level = 'global' OR project_id = <current_project_id>
   │           (vector.sqlite carries privacy_level + project_id as
   │            real columns per §5.2; status filter is post-fusion in
   │            6-stage rerank.)
   │
   ├─ Stage 2:  RRF fusion (k=60) → top-60 fused
   │            score(d) = Σ_streams [ 1 / (k + rank_in_stream) ]
   │
   ├─ Stages 3-8: existing 6-stage rerank (unchanged)
   │   3. Hard filter (status / privacy / project — applies status
   │      filter that FTS5 row didn't carry)
   │   4. Project signature similarity (jaccard)
   │   5. Task signature similarity
   │   6. Evidence quality
   │   7. Applicability guard
   │   8. Diversity (memory_type AND session_id, both ≤ 3 per slice)
   │
   └─ Stage 9:  top-N brief format (Markdown + JSON)
```

**Why the Stage-0a ordering matters (R-003)**: putting Lazy distill
*after* Stage 9 (as in the original draft) meant new hook events
became searchable only on the *next* brief call. In a fresh
standalone install (no cards yet), every first brief returned empty,
contradicting §12 acceptance. Stage 0a fixes this by committing
pending events into the index before candidate generation.

### 5.2 Vector index (`indexes/vector.sqlite`)

```sql
CREATE TABLE IF NOT EXISTS card_vectors (
  memory_id     TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  privacy_level TEXT NOT NULL DEFAULT 'local',
  embedding     BLOB NOT NULL,                       -- Float32, 384 * 4 = 1536 bytes
  dim           INTEGER NOT NULL DEFAULT 384,
  embedded_at   TEXT NOT NULL,
  embed_model   TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2'
);
CREATE INDEX IF NOT EXISTS idx_card_vectors_project
  ON card_vectors(project_id, privacy_level);
```

- Separate SQLite file from `lexical.sqlite`. One backend's failure
  does not disable the other.
- Same global lock as `lexical.sqlite` writes (short critical section
  only — §4.5 Stage 6).
- Brute-force cosine in JS (`Float32Array` dot-product). Performance
  budget: < 5 ms for 1 000 rows on a 2021 MacBook Pro M1. Beyond
  ~10 000 rows, switching to `sqlite-vss` or `hnswlib` is a v0.4.0
  escape hatch.

**C-R1 carry-forward (R-015)**: the v0.1.x known limitation that
`memory_id` is derived from `(memory_type, dedupe_key)` *without*
`project_id` (so two projects with the same `dedupe_key` collide on
the FTS5 row — see `docs/handoff-phase-4-6.md:148-154`) extends to
`card_vectors` as defined above (`memory_id TEXT PRIMARY KEY`, no
project_id in the key). v0.3.0 inherits this single-project-safety
boundary. Resolution depends on the v0.2.0 widening track ("widen
`memoryIdFor()` signature to include projectId + composite
`(memory_id, project_id)` FTS key"). **Phase 0.3.0-γ MUST be
sequenced after that widening lands.** If the widening does not ship
in v0.2.0, Phase 0.3.0-γ must include the same widening for both
`lexical.sqlite` and `vector.sqlite` as a prerequisite task, recorded
in the §11 phase plan dependency column.

### 5.3 Embedding policy

| Item | Policy |
|---|---|
| Model | `Xenova/all-MiniLM-L6-v2` (384 dim, ~80 MB, MIT) |
| Dependency | `@xenova/transformers` in `optionalDependencies` |
| Embedding text | `[title] · [claim] · "applicability:" + values + " · tags:" + tags + " · keywords:" + search_keywords` (one string) |
| Embed timing | Computed **outside** the global lock — §4.5 Stage 5 batches all card embeddings in a single LLM-free CPU-bound pass (model warm-load amortized across the batch). Only the SQLite `card_vectors` upsert runs inside the short critical section B (§4.5 Stage 6). This closes the R2-G contradiction where the earlier wording put the embed step inside the lock and would have failed the G-β-latency gate. |
| Re-embed | `/deep-memory-audit --rebuild-vectors` (missing rows + model-version-mismatch) |
| Query embedding | Per `/deep-memory-brief`; first call ~500-1000 ms (model warmup), subsequent ~30-50 ms cached |
| Model version pin | `.embed-model-version` file stores `<model-name>@<package-version>`; mismatch triggers prompted rebuild (interactive) AND immediate vector-stream abort (non-interactive) — see §5.3.1 |

#### 5.3.1 Vector model-version mismatch handling (R-006)

`.embed-model-version` is checked **on every** `deep_memory_brief` /
`deep_memory_smart_search` / `deep_memory_recall` invocation, before
Stage 1 of the retrieval pipeline:

```
# R4-I: try-catch the @xenova require so absent optional dep
# doesn't throw before the graceful FTS5-only fallback path.
try:
    loaded_model_version = require('@xenova/transformers/package.json').version
                            + '@' + EMBED_MODEL_ID
except (MODULE_NOT_FOUND | ImportError):
    # @xenova/transformers absent — graceful degrade to FTS5-only.
    # §5.4 matrix rows 3 + 6 cover this state. Skip mismatch check
    # entirely; proceed to retrieval with vector stream disabled.
    return FTS5_ONLY_RETRIEVAL

stored_version = read('.embed-model-version')

if stored_version is absent:
    write('.embed-model-version', loaded_model_version)
    proceed (no abort — first-time setup)

elif stored_version != loaded_model_version:
    # mismatch — silent corruption risk if we use vector stream
    abort vector stream entirely for this invocation
    add warnings[] entry: "Vector index stale (model changed from
        ${stored_version} to ${loaded_model_version}). FTS5-only
        retrieval used. Run `/deep-memory-audit --rebuild-vectors`
        to re-embed all cards under the new model."
    proceed to retrieval with FTS5-only (vector stream skipped)

else:
    proceed with full hybrid retrieval
```

The `--rebuild-vectors` command re-embeds all cards under the
currently loaded model, then atomically updates `.embed-model-version`.
During rebuild, briefs continue with the FTS5-only fallback. The
graceful degradation matrix (§5.4) gains a new row for this state
(see §5.4).

### 5.4 Graceful degradation matrix

| `better-sqlite3` | `sql.js` (v0.2.0 fallback) | `@xenova/transformers` | `.embed-model-version` | Behavior |
|:---:|:---:|:---:|:---:|---|
| ✓ | n/a | ✓ | match | **Full hybrid** (FTS5 + Vector) |
| ✓ | n/a | ✓ | mismatch | FTS5-only + warning (R-006); user runs `--rebuild-vectors` |
| ✓ | n/a | ✗ | n/a | FTS5-only, vector stream skipped + warning |
| ✗ | ✓ | ✓ | match | Full via sql.js |
| ✗ | ✓ | ✓ | mismatch | FTS5-only via sql.js + warning |
| ✗ | ✓ | ✗ | n/a | FTS5-only via sql.js |
| ✗ | ✗ | irrelevant | irrelevant | Total degraded → empty brief + actionable error |

Warnings are surfaced via:
- `cards.warnings[]` on harvest return (non-enumerable, mirrors v0.1.2/v0.1.3 pattern)
- `latest-brief.warnings[]` field
- `latest-harvest.warnings[]` field
- MCP `deep_memory_brief` response `warnings[]` field

Warning strings pass through `redactString` (v0.1.3 invariant) so any
homedir-style paths are masked to `~/…`.

**`--rebuild-vectors` in-progress state** (round-2 R2-O + round-3 R3-H clarification):
while `/deep-memory-audit --rebuild-vectors` runs, it holds the
global `.lock` for the duration of the rebuild (potentially seconds
to minutes for large stores). Concurrent `brief` calls during this
window fall through to the FTS5-only tier per §6.6's tier-2 contract
(short critical section A fails to acquire → brief proceeds with
FTS5-only retrieval + `warnings[]` entry "vector index rebuild in
progress, FTS5-only retrieval"). Once rebuild completes and
`.embed-model-version` is atomically updated (single `fs.renameSync`
at the end of rebuild), the next brief observes the new file and
uses full hybrid stream.

**R3-H hook-side impact during rebuild**: hook scripts (§3.2 step 5)
acquire the same global `.lock` for events.jsonl atomic append.
During a multi-minute rebuild, every PostToolUse hook in every
project waits for the lock. v0.3.0 accepts this as a **UX trade-off**
since rebuild is rare (model-upgrade-only, user-initiated). Mitigation:
- **Documentation**: `/deep-memory-audit --rebuild-vectors` slash skill
  surfaces "Rebuilding vector index — hook scripts will pause until
  complete (~Ns estimated)" before starting.
- **Stress gate** (added to §3.2.2): G-β macrobenchmark run once
  more with `--rebuild-vectors` concurrent, record p95 for forensics
  (do NOT block phase merge — rebuild is explicit, not background).
- **Future** (v0.3.x): split into separate `.rebuild.lock` that
  conflicts only with vector-write paths, leaving events.jsonl
  append unblocked. Recorded as §15 plan-phase open question.

### 5.5 Why RRF (not weighted sum)

- **Scale-free.** BM25 raw score is unbounded; cosine ∈ [-1, 1].
  Direct weighted sum requires per-stream normalization that drifts
  per-project. RRF uses *rank only* — no scale dependency.
- **One hyperparameter (k=60).** Matches agentmemory default. No
  per-project tuning.
- **Robust to one weak stream.** If vector quality is poor on a given
  query (e.g. CJK without segmenter, exotic acronym), FTS5 hits still
  surface; vice versa.

### 5.6 Session diversification

- Existing 6-stage Stage 8 (Diversity) currently diversifies on
  `memory_type`. v0.3.0 extends it to **also** cap results per
  `session_id` (from `payload.deep_memory_provenance[0].session_id`
  when present).
- Config: `config.yaml#brief.max_per_session: 3` (default).
- Older cards lacking `session_id` (from v0.1.x sibling artifact
  origin) bypass this filter naturally — the per-session counter
  treats null as unique.

### 5.7 Performance budget

| Operation | Target |
|---|---|
| Embedding model warmup (per process, 1×) | 500–1000 ms |
| Query embedding (cached model) | 30–50 ms |
| FTS5 top-30 | < 10 ms |
| Vector top-30 (brute force on 1k rows) | ~5 ms |
| RRF fusion + 6-stage rerank | < 5 ms |
| Brief format + write | < 10 ms |
| **First brief in process** | **< 1.5 s** |
| **Subsequent briefs** | **< 200 ms** |

---

## 6. MCP Server Surface

### 6.1 Server entry & auto-wiring

```
scripts/mcp-server.mjs           ← stdio entry, ~200 lines (tool registration only)
  └─ depends on @modelcontextprotocol/sdk (dep)
```

> Module system note: `scripts/mcp-server.mjs` uses the `.mjs`
> extension to opt into ES modules — `@modelcontextprotocol/sdk@1.x`
> is ESM-only. Existing `scripts/*.js` remain CommonJS (no breaking
> change). The MCP server file calls into existing CommonJS lib
> modules via dynamic `import()` plus interop, isolating the ESM
> boundary inside the server file.

`.claude-plugin/plugin.json` `mcpServers` entry:
```json
"mcpServers": {
  "deep-memory": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"],
    "env": { "DEEP_MEMORY_ROOT": "${DEEP_MEMORY_ROOT:-}" }
  }
}
```

`.codex-plugin/plugin.json` references the entry via a plugin-relative
path (R4-G — Codex manifest convention uses `"mcpServers": "./.mcp.json"`,
NOT inline object like Claude Code):
```json
{ "name": "deep-memory",
  "version": "0.3.0",
  "mcpServers": "./.mcp.json",
  "hooks": { /* Codex 4-hook subset — see §3.5 */ } }
```
The actual server entry then lives in `.mcp.json` at the plugin root:
```json
{ "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"],
      "env": { "DEEP_MEMORY_ROOT": "${DEEP_MEMORY_ROOT:-}" }
    } } }
```
§7 storage layout updated implicitly: `.mcp.json` lives at plugin root
(not in `~/.deep-memory/`). Both Claude Code (inline) and Codex (path)
auto-spawn the same `scripts/mcp-server.mjs` as a child process on
session start, send JSON-RPC over stdio, and reap it on session end.
Zero additional user setup.

### 6.2 Tool naming — `deep_memory_*` (deliberately distinct from agentmemory `memory_*`)

Rationale:
- Avoid namespace collision when both `agentmemory` and `deep-memory`
  are installed in the same host.
- The `deep_memory_` prefix makes the plugin origin self-evident in
  tool listings and call traces.
- Brainstorming decision D1 ("absorb agentmemory's core") is about
  *functional parity*, not *literal name equality*.

### 6.3 Tool list (10 — MVP minimum)

| # | Tool | Inputs (summary) | Implementation delegate | Use case |
|---|---|---|---|---|
| 1 | `deep_memory_brief` | `task: string, limit?: int=5` (project_scope **fixed at `'current'`** for MCP-autonomous calls; see §6.3.1 below) | `scripts/brief.js#runBrief` | Task-specific top-N brief |
| 2 | `deep_memory_smart_search` | `query: string, limit?: int=10` (project_scope fixed at `'current'`) | `scripts/retrieve.js#runRetrieve` (hybrid) | Direct hybrid search (BM25+vector+RRF) |
| 3 | `deep_memory_recall` | `query: string, limit?: int=10` (project_scope fixed at `'current'`) | `scripts/retrieve.js#runRetrieve` with `vector: false` | Lightweight lexical recall |
| 4 | `deep_memory_save` | `memory_type, title, claim, evidence?, tags?, privacy?: 'local' (only)` | NEW `scripts/save.js#saveMemory` | Explicit save (agent or `/remember`) |
| 5 | `deep_memory_harvest` | `source?: 'siblings'\|'all'='all', limit?: int` | `scripts/harvest.js` | Manual distill trigger. The `'hooks'` value was removed in round-1 response to R-014 (and re-removed at the MCP signature here in round-2 R2-C) — hook distill is always-on via Lazy/Eager triggers (§4.3). Use `--rebuild-from-events` for retroactive hook re-distill. |
| 6 | `deep_memory_audit` | autonomous MCP: `mode: 'check'` only (const). Slash: `mode?: 'check'\|'unlock'\|'rebuild-index'\|'rebuild-vectors'`, `promote?: <id>` | `scripts/audit.js` | Schema/stale/lock/vector audit. **Non-`check` modes are slash-only in v0.3.0 per §6.3.1 Gate 2 (R3-B option a)**; autonomous MCP call with non-`check` mode returns `error: slash_only_in_v030`. |
| 7 | `deep_memory_forget` | `memory_id: string, reason: string` | NEW `scripts/forget.js#softForget` | Soft-delete (status → `deprecated`) + audit log. **Slash-only in v0.3.0 per §6.3.1 Gate 2 (R3-B option a); MCP exposure DEFERRED to v0.3.x** once a host-side consent protocol is specified. Row kept here for symmetry with §6.8 mapping and to make the deferral visible. Autonomous MCP call to this tool returns `error: slash_only_in_v030`. |
| 8 | `deep_memory_sessions` | `limit?: int=10` | `events.jsonl` scan | Recent sessions list. Response item shape: `{ session_id, host, started_at, ended_at?, event_count, top_tool_names: string[] }` |
| 9 | `deep_memory_profile` | (no input) | `.deep-memory/project-profile.json` read | Current project profile |
| 10 | `deep_memory_export` | autonomous MCP: `format: 'json'\|'jsonl', filter?: {memory_type?, status?}` (NO `project_id` — current project only via server substitution). Slash: full filter incl. `project_id` and `--all-projects` flag. | NEW `scripts/export.js` | Backup / migration. **MVP scope cap**: no streaming, one format per call, full-table dump (filter applies after read), max 10 000 cards per call. **Cross-project export is slash-only per §6.3.1 Gate 3 (R3-B option a)**; autonomous MCP cannot request other-project export. |

New business logic added in v0.3.0: `save.js`, `forget.js`, `export.js`
(each < 100 lines, thin adapters over existing lib modules).

#### 6.3.1 Privacy gates on autonomous MCP surface (R-008 + round-2 R2-D)

The autonomous MCP surface enforces **three** distinct gates, each
defended in BOTH the inputSchema (compile-time) AND a runtime check
(runtime — for non-conformant hosts that ignore schema enforcement):

##### Gate 1 — Cross-project read (closed by R-008, sharpened by R2-D-a / R2-K)

`project_scope: 'all'` is **NOT exposed** on autonomous MCP tools.
`deep_memory_brief` inputSchema declares `project_scope` as
`const: 'current'`; `deep_memory_smart_search` and `_recall`
inputSchemas omit the field entirely. Runtime check in
`scripts/retrieve.js` rejects any non-`current` scope with
`error: scope_not_permitted`. Cross-project reads available only
via:
1. **Slash skills** with explicit `--all-projects` flag (user types
   the flag — explicit consent). Audit-log entry `{at, user, scope:
   'all', projects_read: [<list>]}`.
2. **`/deep-memory-audit --cross-project-read <task>`** subcommand.
3. **`deep_memory_export`** MCP tool — see Gate 3 below.

##### Gate 2 — Memory mutation is SLASH-ONLY in v0.3.0 (round-3 R3-B option (a) — consent_token mechanism removed)

**Decision (R3-B + R3-E + R3-I + R3-J resolution)**: the
round-2 `consent_token` design (host-computed SHA-256 token verified
only by structural shape) was found unimplementable AND forgeable in
round-3 review. Three reviewers (Opus R3-002, Codex adversarial
HIGH-1, Codex review P2-1) converged on the recommendation: **remove
mutation from the autonomous MCP surface entirely**. v0.3.0 ships:

- **Autonomous MCP `deep_memory_audit`**: inputSchema `mode` is
  `const: 'check'` (read-only only). All other modes (`unlock`,
  `rebuild-index`, `rebuild-vectors`, `promote`) are **slash-only**
  via `/deep-memory-audit [--unlock | --rebuild-index | --rebuild-vectors | --promote <id>]`.
  A non-`check` mode arriving over MCP returns
  `error: slash_only_in_v030, remediation: "use /deep-memory-audit --<mode>"`.
- **Autonomous MCP `deep_memory_forget`**: **REMOVED** from the
  autonomous MCP surface in v0.3.0. The tool is registered as
  slash-only via `/deep-memory-forget <id> "<reason>"`. The §6.3
  tool list keeps row 7 as a placeholder marked
  `(slash-only in v0.3.0; MCP exposure deferred)` for plan-phase
  visibility.
- **Autonomous MCP `deep_memory_save`**: still available; `privacy:
  'local'` only (the round-1 invariant — never `global`). Save is
  additive and reversible (the user can always `/deep-memory-forget`
  the saved card), so it doesn't need a consent gate.
- **Slash invocation IS consent.** User typing `/deep-memory-audit --promote <id>`
  in their terminal is the consent action. The slash skill records
  `audit-log` entry `{at, kind: 'mutation-consent', tool, args, by:
  'slash-direct'}` — note the simpler shape: no `consent_token` field
  at all, no opaque hash to verify. Forensic reader gets the actual
  args and the slash-skill provenance.
- **Future MCP exposure** (v0.3.x+): when a host vendor agrees on a
  consent protocol shape (server-issued nonce + signed approval +
  consent_store), the autonomous MCP surface for mutation operations
  can be re-introduced. This is recorded as a §15 plan-phase open
  question (added in R3-N).

This removes the entire consent_token machinery (no SHA-256 prefix,
no structural-shape verification, no 'slash-direct' magic string, no
host-side specification gap). Gate 2's intent — "user-owned memory
mutation requires user consent" — is enforced by the simplest
mechanism: the user must type the slash command. Asymmetric defense
becomes symmetric: Gate 1 = inputSchema `const`, Gate 2 = slash-only
(no MCP exposure), Gate 3 = inputSchema `const` (per §6.3.1 Gate 3).

##### Gate 3 — Cross-project export is SLASH-ONLY (R3-B option (a) extends here too)

`deep_memory_export` autonomous MCP surface is current-project-only,
hard-restricted at the schema level (mirroring Gate 1's pattern):

- **inputSchema**: `filter.project_id` is **omitted from the
  autonomous inputSchema entirely** — the server substitutes the
  current project_id internally. Autonomous callers cannot request
  a different project's cards. A schema-violating call (extra
  property) returns the MCP host's normal validation error.
- **Cross-project export** is **slash-only**: `/deep-memory-export
  --project=<id>` or `--all-projects`. The slash skill records
  `audit-log` entry `{at, kind: 'cross-project-export', scope, by:
  'slash-direct', exported_count, target_path}`. No `consent_token`,
  no TTY check on the MCP side — the slash invocation is the
  consent.
- **MCP resources**: `deep-memory://project/{project_id}/profile`,
  `deep-memory://cards/latest`, and `deep-memory://audit/last`
  resources accept only `project_id == <current>` (server-substituted
  at request time — clients cannot inject other project_ids via URI
  templating). Out-of-scope URI returns `404 Not Found` with body
  `{ error: "slash_only_in_v030", message: "cross-project resource access is slash-only; use /deep-memory-* commands" }`.
- **Always-current resources** (`deep-memory://status`,
  `deep-memory://config`) are scope-naturally bound and not gated.

##### Gate violation responses (uniform shape) + audit-log envelope (R3-J fix)

All three gates return structured errors so hosts can surface
actionable messages:

```json
{ "error": "scope_not_permitted" |       // Gate 1 — cross-project read
           "slash_only_in_v030" |          // Gates 2 & 3 — mutation / cross-project export
           "cross_project_export_requires_consent", // (retained for forward-compat with R3-B option c if adopted in v0.3.x)
  "message": "<human-readable explanation>",
  "remediation": "<slash-skill command to retry>",
  "audit_entry_id": "<ULID written into audit-log>" }
```

**Audit-log entry envelope (R3-J fix — uniform shape across all writers)**:
every entry in `audit-log/YYYY-MM.jsonl` follows the envelope:

```json
{ "at": "<RFC3339 timestamp>",
  "id": "<ULID, monotonic>",
  "kind": "capture-toggle" | "cross-project-read" |
          "mutation-consent" | "gate-violation" |
          "save" | "forget" | "cross-project-export" |
          "promote" | "rebuild" | "unlock",
  "by": "slash-direct" | "mcp-autonomous" | "hook-script" | "init-migration",
  "host": "claude-code" | "codex" | "cursor" | "(none)" | ...,
  "payload": { /* kind-specific fields */ } }
```

Per-kind payload shapes (validated by `schemas/audit-log-entry.schema.json`,
added in Phase 0.3.0-ε):

| `kind` | `payload` shape |
|---|---|
| `capture-toggle` | `{from: bool, to: bool, method: 'prompted' | 'cli-flag' | 'non-interactive-default'}` |
| `cross-project-read` | `{scope: 'all', projects_read: [<id>...], tool: 'brief'\|'smart_search'\|'recall'}` |
| `mutation-consent` | `{tool: 'audit'\|'promote'\|'forget'\|'rebuild-index'\|'rebuild-vectors'\|'unlock', args: {...}}` (R4-L: `'unlock'` added — slash `/deep-memory-audit --unlock` is a mutation that needs consent-trail entry) |
| `gate-violation` | `{tool, requested_scope, denial_reason: 'gate1'\|'gate2'\|'gate3', error}` |
| `save` | `{memory_id, memory_type, privacy: 'local'}` |
| `forget` | `{memory_id, reason}` |
| `cross-project-export` | `{scope, exported_count, target_path}` |
| `promote` | `{memory_id, from_privacy: 'local', to_privacy: 'global'}` |
| `rebuild` | `{index: 'lexical'\|'vector', cards_processed: int, duration_ms: int}` |
| `unlock` | `{lock_holder_pid: int, stale_for_seconds: int}` |

**Why this envelope** (R3-J justification): round-2's response added
audit-log entries ad-hoc per-gate with 5 different shapes; round-3
review (R3-J) flagged this as forensic-unreadable. The envelope makes
every entry self-describing via `kind`, lets `audit-log-entry.schema.json`
declare a `oneOf` over per-kind payloads, and lets forensic readers
filter/aggregate by `kind` cheaply. The `at`/`id`/`kind`/`by`/`host`/`payload`
shape is consistent — the per-kind variability lives only in `payload`.

Every gate violation appends a `gate-violation` entry. Every successful
mutation (slash-skill or hook) appends the appropriate `kind` entry.

**Dual emission for slash-mutations (R4-K clarification)**: a slash
mutation invocation writes TWO entries — first `kind: 'mutation-consent'`
(records the consent action + args, since user typing the slash IS
the consent moment), then the kind-specific entry (`forget`/`promote`/
`unlock`/`rebuild`) recording the actual mutation outcome. Forensic
readers can join the two via shared `at` timestamp (within ms) or via
the consent entry's `payload.tool` matching the second entry's `kind`.
Why two: separates "consent was given" (always exists, even if mutation
later fails) from "mutation succeeded" (only exists when outcome is
recorded). This pattern also extends to v0.3.x if MCP-mutation re-opens
(server-issued consent_token would land in the first entry).

### 6.4 Resources (5)

| URI | Content |
|---|---|
| `deep-memory://status` | health summary: card count, events count, last harvest, FTS5/vector availability |
| `deep-memory://project/{project_id}/profile` | full `project-profile.json` |
| `deep-memory://cards/latest?limit=10` | latest N card metadata |
| `deep-memory://config` | `~/.deep-memory/config.yaml` (low-sensitivity by design — values matching `suppressions.yaml` patterns are still masked via `redactString`, but the file itself contains no secrets) |
| `deep-memory://audit/last` | last audit run result |

### 6.5 Prompts (2)

| Name | Purpose |
|---|---|
| `deep_memory_recall_context` | "Return top-K memories for this task as LLM-injectable context" |
| `deep_memory_session_handoff` | Previous session summary + open thread for next session inject |

### 6.6 Lifecycle & concurrency

Tool concurrency model is **3-tier** (R-010 — fixes the earlier
"lockless" oversimplification that ignored the Lazy distill write path
inside `brief`):

| Tier | Tools | Lock model |
|---|---|---|
| **Truly lockless** (no disk write, no index advance) | `recall`, `sessions`, `profile`, `audit mode=check`, `export` (current-project mode only — see §6.3.1 Gate 3; cross-project export is slash-only per R3-B option a / §6.3.1 rewrite) | Concurrent reads safe. FTS5 + vector readers tolerate concurrent reads under both better-sqlite3 (multi-process safe) and sql.js (in-process, but read-only access is mutex-free if no concurrent writes are in flight — see §15 Q4 plan-phase verification). |
| **Read-with-lazy-side-effect** | `brief`, `smart_search` | These trigger Stage 0a Lazy distill (§5.1) which is a *write* path. If `pending_events == 0`: behaves as truly lockless. If `pending_events > 0`: acquires short critical section A (§4.5 Stage 1) for the cursor scan, then critical section B (§4.5 Stage 6) for commit. Two concurrent briefs serialize on these short sections; the second one finds the cursor advanced by the first and processes only newly-pending events. |
| **Write tools** | `save`, `harvest`, `forget`, `audit mode∈{unlock,rebuild-index,rebuild-vectors,promote}` | Acquire the global `.lock` for the duration of their disk-commit critical section. `save` and `forget` are bounded (~ms); `audit mode=rebuild-*` may hold the lock for seconds (during which other write tools and read-with-lazy briefs block on critical-section acquire — these long ops are explicit user-initiated, so the wait is expected). |

- **Project lease** acquired for `harvest` / `save` just as in slash
  skill path (same code).
- **Process model**: server runs while host holds the stdio pipe.
  EOF on stdin → graceful shutdown, release any held lease/lock,
  flush in-process embedding model cache. Two concurrent MCP calls
  in the same server process share the same Node event loop — the
  embedding model cache is shared and no extra synchronization is
  needed for read-only model use.
- **Embedding model cache**: the `@xenova/transformers` model loads
  once per process; subsequent tool calls reuse the in-memory model
  (subsequent latency < 50 ms vs. cold ~500-1000 ms).
- **Multi-host scenario** (Claude Code AND Codex both spawn this MCP
  server in the same project): two server processes, two separate
  embedding model caches (one per process), but they share the same
  `~/.deep-memory/` storage. The mkdir-based `.lock` is multi-process
  safe (atomic mkdir semantics), so concurrent writes from the two
  processes serialize correctly via lock contention.

### 6.7 Privacy invariant for MCP path

- All write tools pass through Pass 1 / Pass 2 / Pass 3 redaction
  (Pass 0 is hook-only; MCP tool input is treated as explicit agent
  text).
- `deep_memory_save` rejects `privacy: 'global'` outright — global
  promotion is reserved for `deep_memory_audit promote: <id>`
  (mirrors slash skill `/deep-memory-audit --promote`).
- `deep_memory_forget` is **slash-only in v0.3.0** (per §6.3.1 Gate 2,
  R3-B option (a)). The slash skill `/deep-memory-forget <id> "<reason>"`
  does NOT hard-delete — card transitions to `status: deprecated` via
  existing state machine, and an audit-log entry is appended per the
  §6.3.1 uniform envelope: `{at, id, kind: 'forget', by: 'slash-direct',
  host, payload: {memory_id, reason}}` to `~/.deep-memory/audit-log/YYYY-MM.jsonl`.
  Autonomous MCP `deep_memory_forget` calls return
  `error: slash_only_in_v030` (the tool is registered as a placeholder
  in §6.3 row 7 for plan-phase visibility, never actually callable
  from MCP in v0.3.0).

### 6.8 Slash skill ↔ MCP tool mapping

| Slash command (user calls explicitly) | MCP tool (agent calls autonomously) | Action |
|---|---|---|
| `/deep-memory-init` | (none — one-time setup) | Initialize memory root |
| `/deep-memory-harvest [args]` | `deep_memory_harvest` | Distill trigger |
| `/deep-memory-brief "<task>"` | `deep_memory_brief` | Top-N brief (autonomous = current project) |
| `/deep-memory-audit [args]` | `deep_memory_audit mode='check'` only (R3-B: non-`check` modes slash-only) | Audit/management |
| `/deep-memory-remember "<text>"` *(NEW)* | `deep_memory_save` | Explicit save (privacy: 'local' only — `global` is slash-via-audit-promote) |
| `/deep-memory-recall "<query>"` *(NEW)* | `deep_memory_recall` / `_smart_search` | Lightweight lookup (current project) |
| `/deep-memory-forget <id> "<reason>"` *(NEW)* | — *(slash-only in v0.3.0; R3-B option a; MCP exposure deferred to v0.3.x)* | Soft-delete |
| `/deep-memory-export [--project=<id> \| --all-projects] --format=json` *(NEW)* | `deep_memory_export` (current project only) | Backup / migration; cross-project requires slash flag |

The 3 new slash skills (`/deep-memory-remember`, `/deep-memory-recall`,
`/deep-memory-forget`) are thin SKILL.md wrappers that call the same
underlying lib functions as the corresponding MCP tools (zero logic
duplication).

### 6.9 Tool input schema example (`deep_memory_brief`)

```json
{
  "name": "deep_memory_brief",
  "description": "Return a task-specific memory brief (top-N relevant memory cards). Hybrid retrieval over FTS5 + local vector embeddings.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task":          { "type": "string",  "minLength": 3, "description": "What the agent is about to do" },
      "limit":         { "type": "integer", "minimum": 1, "maximum": 30, "default": 5 },
      "project_scope": { "const": "current", "default": "current" }
    },
    "required": ["task"]
  }
}
```

Response shape: `{ memories: Card[], warnings: string[], generated_at: string, distilled_events: int }`.

**`deep_memory_smart_search` and `deep_memory_recall` inputSchemas** (R2-K): identical shape but with the `project_scope` field **omitted entirely** (defense in depth — autonomous MCP forces current-project per §6.3.1; the schema doesn't even acknowledge a "scope" parameter exists). Slash-only paths surface `--all-projects` as a CLI flag, never as an MCP `inputSchema` enum value. This belt-and-suspenders pattern means a non-conformant MCP host that ignores `const` constraints still cannot trigger cross-project reads through these tools.

### 6.10 Dependency impact

```jsonc
// package.json delta (v0.2.x → v0.3.0)
{
  "dependencies": {
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0"      // NEW (~200 KB)
  },
  "optionalDependencies": {
    "better-sqlite3": "^12.0.0",
    "sql.js": "^1.10.0",
    "@xenova/transformers": "^2.17.2"          // NEW (graceful)
  }
}
```

### 6.11 Out-of-MVP MCP tools (deferred)

- `deep_memory_graph_query` — needs Phase 5 (Reasoning Graph) alignment, deferred.
- `deep_memory_team_share` / `_signal_send` — multi-agent coordination, low priority.
- `deep_memory_consolidate` (manual 4-tier consolidation) — Lazy/Eager auto distill covers the use case.
- `deep_memory_snapshot` / git versioning — existing git workflow suffices.
- REST/viewer surfaces — intentionally excluded (D5).

---

## 7. Storage Layout

```
~/.deep-memory/                      v0.1.3    v0.2.0   v0.3.0
├── config.yaml                        ✓         ✓        ✓ (+new keys, backward-compat)
├── .storage-version                   —         —        ✓ NEW  ("0.3")
├── cards/<type>/<proj>/<id>.json      ✓         ✓        ✓ (M3 envelope unchanged)
├── events/YYYY-MM.jsonl               ✓         ✓        ✓ (+ new artifact_kind `memory-hook-event` lines co-exist with `memory-event`; see §3.4. Discriminated by `envelope.artifact_kind`.)
├── indexes/lexical.sqlite (FTS5)      ✓         ✓ (sql.js fallback) ✓
├── indexes/vector.sqlite              —         —        ✓ NEW
├── projects/<proj_id>/profile         ✓         ✓        ✓
├── .leases/<proj_id>.lease            ✓         ✓        ✓
├── .lock (mkdir)                      ✓         ✓        ✓
├── .last-distill-cursor/<proj_id>     —         —        ✓ NEW
├── .embed-model-version               —         —        ✓ NEW
├── audit-log/YYYY-MM.jsonl            —         —        ✓ NEW
└── .quarantine/                       ✓         ✓        ✓
```

Project-local `<repo>/.deep-memory/`:
```
├── project-profile.json               ✓ ✓ ✓
├── latest-harvest.json                ✓ ✓ ✓
├── latest-brief.{json,md}             ✓ ✓ ✓
├── latest-distill.json                — — ✓ NEW (Lazy distill summary)
└── hooks-stats.json                   — — ✓ NEW (opt-in capture telemetry)
```

**Hard invariant**: existing directories/files unchanged. All v0.3.0
additions are net-new.

---

## 8. Migration

### 8.1 v0.2.0 → v0.3.0 (one-time, automatic)

`scripts/init.js` reads `.storage-version` and, when finding `"0.2"`,
performs:

```
v0.3.0 first-run migration
  │
  ├─ 1. read .storage-version → "0.2"
  │
  ├─ 2. mkdir -p indexes/ (vector.sqlite), audit-log/, .last-distill-cursor/
  │
  ├─ 3. CREATE TABLE card_vectors (...) in indexes/vector.sqlite
  │
  ├─ 4. scan cards/ → count N. Embed policy depends on entry mode:
  │      ┌─ INTERACTIVE entry (isatty(stdin) AND isatty(stdout)) ─┐
  │      │  if N == 0 OR @xenova absent: skip (graceful)           │
  │      │  if N ≤ 50:  auto-embed (tens of seconds)              │
  │      │  if N >  50: prompt "Embed N cards (~Ts), continue?    │
  │      │              [Y/n]"  — default Y on interactive         │
  │      └─────────────────────────────────────────────────────────┘
  │      ┌─ NON-INTERACTIVE entry (MCP server start, hook subproc) ┐
  │      │  ALWAYS skip embedding step.                            │
  │      │  Write `latest-distill.warnings[]`:                     │
  │      │    "Vector index not built (N cards, non-interactive    │
  │      │     migration). Run `/deep-memory-audit --rebuild-vectors`│
  │      │     to embed."                                          │
  │      │  Surface the same warning on `deep-memory://status`     │
  │      │  MCP resource.                                          │
  │      │  R-013: prompt MUST NOT fire from a process whose stdio │
  │      │  is the host's JSON-RPC pipe — that corrupts protocol.  │
  │      └─────────────────────────────────────────────────────────┘
  │
  ├─ 5. .last-distill-cursor/<proj_id> ← `<current-month>.jsonl:<current_file_size_in_bytes>`
  │      (e.g. `2026-05.jsonl:184320` — byte immediately past current tail;
  │       MUST match the cursor format defined in §3.4.3, NOT an ISO timestamp.
  │       Older events implicitly treated as already-processed.
  │       Opt-in `--rebuild-from-events` resets cursor to `<current-month>.jsonl:0`
  │       to retroactively distill the entire current month.)
  │
  ├─ 6. config.yaml ← merge new default keys (existing keys preserved).
  │      Capture default depends on entry mode (R-007):
  │      ┌─ INTERACTIVE upgrade entry (slash skill in user terminal) ─┐
  │      │  prompt: "Enable auto-capture (hook-based)? [Y/n default N]"│
  │      │  user choice → capture.enabled                              │
  │      │  → audit-log entry per §6.3.1 envelope:                    │
  │      │    { at, id, kind: 'capture-toggle', by: 'init-migration', │
  │      │      host, payload: { from: false, to: <choice>,           │
  │      │                       method: 'prompted' } }               │
  │      │  (R4-E correction: 'prompted' not 'prompted-upgrade' —     │
  │      │   matches §6.3.1 envelope's method enum)                   │
  │      └─────────────────────────────────────────────────────────────┘
  │      ┌─ NON-INTERACTIVE upgrade entry (MCP, hook) ────────────────┐
  │      │  capture.enabled defaults to FALSE.                         │
  │      │  audit-log per §6.3.1 envelope:                            │
  │      │    { at, id, kind: 'capture-toggle', by: 'init-migration', │
  │      │      host, payload: { from: false, to: false,              │
  │      │                       method: 'non-interactive-default' } }│
  │      │  Status resource surfaces "auto-capture OFF — opt in via   │
  │      │  `/deep-memory-init --enable-capture`"                      │
  │      └─────────────────────────────────────────────────────────────┘
  │      Other default keys (no policy split):
  │        capture.eager_distill: false
  │        brief.max_per_session: 3
  │        vector.embed_model: "Xenova/all-MiniLM-L6-v2"
  │        distill.batch_size: 5
  │        distill.max_drafts_per_session: 10
  │        distill.max_llm_tokens_per_run: 50000
  │
  └─ 7. .storage-version ← "0.3"
```

Trigger: `init.js` is invoked automatically by every entry point
(`/deep-memory-harvest`, `/deep-memory-brief`, MCP server start, etc.)
via a preflight check. Migration runs at most once. The interactive
vs non-interactive split in steps 4 and 6 prevents stdio JSON-RPC
corruption (R-013) and silent always-on capture activation (R-007).

### 8.2 v0.1.3 → v0.3.0 (two-step) AND v0.2.x detection (round-2 R2-F fix)

**Round-2 R2-F finding**: §7 declares `.storage-version` as a
v0.3.0-new file — i.e. real v0.2.x users do NOT have it. An
absent-file guard cannot distinguish v0.1.x from v0.2.x by
`.storage-version` alone, breaking automatic v0.2.0 → v0.3.0
migration.

**Resolution — multi-marker detection** (no coordination with v0.2.0
needed; the markers are storage facts):

```
init.js storage-version detection algorithm (R3-D-corrected):
  if `.storage-version` file exists:
      use its content directly ("0.2" / "0.3" / ...)
  else:
      # `.storage-version` absent — need to distinguish v0.1.x vs v0.2.x.
      # R3-D: lexical.sqlite alone is INSUFFICIENT (v0.1.x also uses FTS5).
      # R4-J: first card's producer_version is INSUFFICIENT (v0.2.x stores
      #   retain v0.1.x cards because v0.2.0 sql.js track doesn't rewrite
      #   envelopes). Use MAX producer_version across multiple cards.
      Scan up to 50 cards in cards/<type>/<proj>/*.json (sample-bounded
      for speed) — collect all envelope.producer_version values.
      max_version = lex-max of collected producer_versions (e.g.
        ["0.1.3", "0.2.0", "0.2.1"] → "0.2.1")
      if max_version starts with "0.3.":
        # mixed: some v0.3.0 cards exist — should have had .storage-version.
        # corrupt/incomplete prior migration — instruct user to
        # `/deep-memory-audit --rebuild-version-marker`.
      elif max_version starts with "0.2.":
        treat as v0.2.x
        → run v0.2.0 → v0.3.0 migration (§8.1)
        → write `.storage-version` = "0.3"
      elif max_version starts with "0.1." (no 0.2 cards found):
        treat as v0.1.x
        → exit cleanly with instruction:
            "deep-memory v0.3.0 requires upgrading to v0.2.x first.
             Install v0.2.x, run /deep-memory-audit once to populate
             .storage-version, then upgrade to v0.3.0."
      else (no cards or no version prefix matches):
        fresh install assumed → run §8.1 init for v0.3.0
```

**Why producer_version inspection** (R3-D): cards carry their
producer's version in the M3 envelope (per `memory-card.schema.json`
`envelope.producer_version`). This is a per-card stable marker — every
card written by v0.2.x has `producer_version: "0.2.x"`, every card
written by v0.1.x has `"0.1.x"`. The detection inspects the *first*
card found (deterministic via directory scan order) and uses its
producer_version as authority. False-positive risk: zero (the field
is required by schema, format-validated, and v0.1.x/v0.2.x do not
share producer_version prefixes).

**Long-term cleaner option**: v0.2.0 backports a `.storage-version "0.2"`
write into its `init.js`. Coordinate with the v0.2.0 sql.js track PR
if not yet shipped. Once v0.2.0 writes `.storage-version`, the
producer_version inspection becomes a fallback for users who upgraded
v0.1.x→v0.3.0 without ever running v0.2.x init.

This avoids a two-jump migration in a single release AND handles the
real-world case where v0.2.x users may not have `.storage-version`.

### 8.3 Downgrade safety

If a user installs v0.3.0, then downgrades to v0.1.x or v0.2.x:
- Card files remain readable (envelope is forward-compatible —
  `producer_version: "0.3.0"` does not invalidate the schema).
- `vector.sqlite`, `audit-log/`, `.last-distill-cursor/`,
  `.embed-model-version` are simply ignored by older versions.
- No card content loss. `.storage-version` stays at "0.3" but is
  harmless to older versions (they don't read it).

Downgrade is therefore safe but informally supported only — we don't
test the reverse-migration path.

---

## 9. Testing

### 9.1 Coverage matrix

Existing v0.1.x suites (244 tests) remain unchanged. v0.3.0 adds
approximately 80 tests (~324 total):

| Area | New tests |
|---|---|
| Hook scripts (6 Tier-1) — stdin fixture → events.jsonl normalization | 12 |
| Pass 0 redaction (API key / JWT / OAuth / AWS key / `<private>` / homedir) | 5 |
| `mapHookSession` — 5 detectors + sessionSummary fallback | 15 |
| Lazy distill trigger + cursor advance + idempotency | 4 |
| Vector index — embed → BLOB → cosine → rank | 8 |
| RRF fusion — FTS5-only / vector-only / both / empty | 6 |
| MCP server — 10 tools (input-schema validate + happy/failure path) | 20 |
| MCP server lifecycle — spawn → multi-call → EOF → lease/lock cleanup | 3 |
| Migration — v0.2.x mock storage → init.js → vector rebuild | 4 |
| Graceful degrade — `@xenova/transformers` absent → FTS5-only fallback | 3 |
| Privacy invariant — `save` rejects `privacy: global`; `forget` is soft only | 2 |

### 9.2 CI matrix

`.github/workflows/ci.yml` cells:

- Node `22` (LTS)
- `DEEP_MEMORY_FTS_BACKEND` ∈ `{better-sqlite3, sqljs}` (env-gated, v0.2.0 contract)
- `@xenova/transformers` ∈ `{installed, absent}` (npm `--no-optional` toggle)
- = **2 × 2 = 4 matrix rows**
- Plus the existing manifest-drift gate as a separate job

### 9.3 Fixtures

- `tests/fixtures/hooks/` — recorded stdin payloads for each Tier-1 hook (1 fixture per host: claude-code, codex).
- `tests/fixtures/sessions/` — bundled events.jsonl for `mapHookSession` testing (`session-with-pattern.json`, `session-with-failure.json`, `session-multi-file-edit.json`, `session-style-repetition.json`, `session-empty.json`).
- `tests/fixtures/mcp-payloads/` — JSON-RPC request/response fixtures per MCP tool.
- `tests/runtime-contract/` — existing per-adapter LLM fixtures preserved.

---

## 10. Out-of-scope (v0.3.0 — explicit)

| Item | Reason | Future plan |
|---|---|---|
| REST API (`:3111`) | D5 — daemon-free design | v0.4.0+ if demand |
| Web viewer (`:3113`) | D5 — separate server required | v0.4.0+ if demand |
| `iii-engine` dependency | D6 — self-contained | permanent |
| Multi embedding provider (OpenAI/Gemini/Voyage/Cohere/OpenRouter) | D4 — local-first | v0.4.0+ provider abstraction |
| Knowledge graph + `graph_query` tool | Phase 5 (Reasoning Graph) separate track | Phase 5 entry gate first |
| Explicit 4-tier storage redesign | D3 — semantic overlay only | permanent |
| TypeScript conversion | D7 — JS-only | permanent |
| Multi-agent coordination (lease/signal/checkpoint/mesh tools) | Solo-agent scenario prioritized | v0.5.0+ |
| Image / multimodal memory | spec §16 carried | TBD |
| Encryption at rest | spec §16 carried | TBD |
| Per-card team scope | privacy_level stays 2-state | TBD |
| `import-jsonl` for old Claude Code transcripts | agentmemory has it; tempting but out of v0.3.0 | v0.3.x follow-up |
| ANN vector index (`sqlite-vss` / `hnswlib`) | brute-force sufficient for typical scale | v0.4.0 escape hatch |
| `PreToolUse` hook | overlaps with `PostToolUse` signal | indefinite |
| Tier-2 hooks (`Stop`, `SubagentStart/Stop`, `TaskCompleted`, `Notification`) | low marginal value, scope cap | v0.3.x follow-up |

---

## 11. Phase plan

Implementation phases (each gated by `deep-review-loop`):

| Phase | Content | PRs | Exit gate (in addition to deep-review-loop) | Depends on |
|---|---|---|---|---|
| **Pre** | v0.2.0 sql.js fallback (already defined, separate track) | separate chain | v0.2.0 release | — |
| **Pre-γ** | C-R1 widening: `memoryIdFor()` includes project_id, composite `(memory_id, project_id)` FTS key | (in v0.2.0 if possible, else inside 0.3.0-γ as prerequisite task) | regression-free re-distill of existing v0.1.x corpus | Pre |
| 0.3.0-α | Hook scripts (6 Tier-1) + Pass 0 / 4-pass redact (uniform ruleset per §3.3) + `memory-hook-event` schema (§3.4) + dual-discriminator dispatch | 2 | **G-α-latency** (§3.2.2): 30-fire p95 ≤ 400 ms | Pre |
| 0.3.0-β | `mapHookSession` + 5 detectors + Lazy distill trigger + Stage 0a integration into brief (§5.1) + cursor mgmt (no `distilled` flag) + batch refine + §4.5 lock split | 2 | **G-β-latency** (§3.2.2): same macro + concurrent brief, p95 ≤ 500 ms | 0.3.0-α |
| 0.3.0-γ | Vector index + `@xenova/transformers` integration + RRF fusion + 6-stage rerank integration + session diversification + §5.3.1 model-version mismatch handling | 2 | Vector hybrid retrieval tests pass under both `match` and `mismatch` model states | 0.3.0-β + Pre-γ |
| 0.3.0-δ | MCP server entry + 10 tools + 5 resources + 2 prompts + 3 new slash skills + §6.3.1 cross-project read gate + §6.6 3-tier concurrency model | 2 | MCP lifecycle test (spawn/multi-call/EOF) + cross-project gate test | 0.3.0-γ |
| 0.3.0-ε | Migration script (§8.1 with interactive/non-interactive split) + audit-log + `.storage-version` bump + capture-default-policy decision (§3.6) + downgrade-safety smoke test + back-to-back-hook smoke test (§3.2.1) | 1 | Migration on a real v0.2.x corpus + downgrade roundtrip lossless | 0.3.0-δ |
| 0.3.0-final | README/CHANGELOG/architecture diagrams + cross-repo `deep-suite` manifest update | 1 | Cross-repo manifest-drift CI green | 0.3.0-ε |

R3 review-loop lesson (carried from v0.1.0 retrospective in
`docs/handoff-phase-4-6.md`): **at least one external reviewer signs
off before plan execution begins**. Per-phase `deep-review-loop`
satisfies this gate.

---

## 12. Acceptance criteria (v0.3.0 release gate)

- [ ] `npm test` passes (324 tests across the 4-cell CI matrix).
- [ ] Plugin install alone (no manual command) results in
      `~/.deep-memory/events/YYYY-MM.jsonl` accumulating hook events
      from the first session forward (when `capture.enabled: true`).
- [ ] **Fresh install** prompts for capture consent on first slash
      invocation; default is `N` (opt-in). Decision logged to
      `audit-log/`.
- [ ] **v0.2.x → v0.3.0 upgrade** with non-interactive entry (MCP
      server start) leaves `capture.enabled: false` and surfaces a
      "auto-capture OFF" warning on `deep-memory://status`.
- [ ] `/deep-memory-brief "<task>"` in a zero-sibling environment
      returns a meaningful brief sourced from hook events
      (standalone validation) — **and the brief is non-empty on the
      FIRST call after capture begins**, because Stage 0a Lazy
      distill commits before retrieval (R-003 acceptance).
- [ ] Calling `deep_memory_brief` via host MCP (Claude Code / Codex)
      returns equivalent results to the slash command.
- [ ] **Cross-project read gate (§6.3.1 Gate 1)** — autonomous MCP call
      with `project_scope: 'all'` returns `error: scope_not_permitted`.
      Slash skill with `--all-projects` succeeds and logs to
      `audit-log/`.
- [ ] **Mutation gate (§6.3.1 Gate 2, R4-F)** — autonomous MCP call
      `deep_memory_audit mode='unlock'` returns
      `error: slash_only_in_v030`; same for `rebuild-index`,
      `rebuild-vectors`, `promote` modes; same for `deep_memory_forget`
      autonomous call. Slash `/deep-memory-audit --unlock` succeeds and
      logs **two** envelope entries (`mutation-consent` then `unlock`)
      per R4-K dual-emission pattern.
- [ ] **Export gate (§6.3.1 Gate 3, R4-F)** — autonomous MCP
      `deep_memory_export` with `filter.project_id` field present is
      schema-rejected (the field isn't in the autonomous inputSchema).
      Slash `/deep-memory-export --project=<id>` succeeds and logs
      `kind: 'cross-project-export'` entry.
- [ ] **Audit-log envelope conformance (R3-J + R4-E + R4-F)** — every
      audit-log entry from all writers (hook script, slash skill, MCP
      server, init migration) validates against
      `schemas/audit-log-entry.schema.json` (added in Phase 0.3.0-ε).
      `by` ∈ `{slash-direct, mcp-autonomous, hook-script, init-migration}`.
      Forensic-readability check: 10 sample entries spanning 5+ distinct
      `kind` values parse uniformly without ad-hoc field-shape sniffing.
- [ ] **`deep_memory_forget` autonomous MCP returns slash-only error
      (R4-A)** — explicit negative test that the MCP tool registration
      placeholder rejects autonomous calls. `grep -F "by: \"mcp-tool\""`
      across the spec returns 0 hits (no vestige of the round-2 design).
- [ ] **Cross-project event filter (R4-C)** — interleaved-project
      fixture: events.jsonl with alternating envelope.project_id values
      A, B, A, B, ...; brief in project A processes only A events;
      A's cards/ directory gets zero B-origin cards; A's cursor
      advances past B lines (they're ignored, not blocking).
- [ ] **capture.enabled gate (R4-D)** — with `config.capture.enabled:
      false`, 30 PostToolUse hook fires leave `events/YYYY-MM.jsonl`
      unchanged (no read, no write). With `capture.enabled: true`
      same 30 fires append 30 lines normally.
- [ ] **Token-cap deferred lines reachable (R4-B)** — a brief that hits
      `distill.max_llm_tokens_per_run` after processing N of M drafts:
      cursor advances past line N's byte offset (NOT past line N+1's
      byte where the deferred draft sits); next brief picks up the
      deferred drafts (no events lost).
- [ ] `@xenova/transformers` absent → graceful FTS5-only fallback
      with explicit `cards.warnings` / `latest-brief.warnings` entry.
- [ ] **Vector model-version mismatch** → vector stream aborts, FTS5
      stream returns results, `warnings[]` carries the actionable
      `--rebuild-vectors` hint.
- [ ] v0.2.x → v0.3.0 migration is automatic (non-interactive
      pathways never prompt); v0.3.0 → v0.2.x downgrade preserves
      all card content.
- [ ] **G-α-latency gate**: 30-fire PostToolUse macrobenchmark p95 ≤
      400 ms at end of Phase 0.3.0-α (§3.2.2).
- [ ] **G-β-latency gate**: same macrobenchmark + concurrent
      `/deep-memory-brief` mid-stream, p95 ≤ 500 ms at end of Phase
      0.3.0-β (proves §4.5 lock split actually frees hook latency).
- [ ] **Back-to-back hook fire**: PreCompact + SessionEnd fired
      within 1 s leaves at most one distill child running, and
      `.lock` / `.leases/` are clean within 60 s of session exit
      (§3.2.1 invariant test).
- [ ] **Two concurrent briefs in same project**: both complete
      successfully, second one finds cursor advanced (no duplicate
      cards on disk), optimistic-concurrency contract holds (§4.5).
- [ ] 4-pass redaction: API key / JWT / `<private>` / homedir
      fixtures never appear in any of `events/`, `cards/`,
      `audit-log/`, `latest-*.json` — applied uniformly across all
      capture channels (hook / skill / MCP — promoted rules per
      §3.3 R-011 fix).
- [ ] All warnings pass through `redactString` (no raw homedir paths
      in any warning message).
- [ ] `events/YYYY-MM.jsonl` contains mixed-artifact-kind lines
      (`memory-event` + `memory-hook-event`) and both validate
      independently against their respective schemas. v0.1.x readers
      that filter to `memory-event` ignore the new lines gracefully.
- [ ] **Quarantine edge case 1** (R2-M): a `memory-hook-event` line
      failing `memory-hook-event.schema.json` validation routes to
      `.quarantine/` without crashing v0.1.x readers in the same
      `events/YYYY-MM.jsonl` file.
- [ ] **Quarantine edge case 2** (R2-M): a pre-v0.3.0 legacy line
      lacking `envelope.artifact_kind` field is treated as
      `memory-event` by the dispatcher (preserves v0.1.x
      compatibility), validated against the existing
      `memory-event.schema.json`.
- [ ] **Quarantine edge case 3** (R2-M): concurrent v0.3.0 hook
      append + slash-skill `/deep-memory-remember` append to the same
      `events/YYYY-MM.jsonl` preserve atomic per-line order
      (verified via OS-level fixture: two processes appending
      pre-recorded JSON lines with `fsync` between, no line
      interleaving observed).
- [ ] CHANGELOG, README, README.ko, architecture diagram, MCP wiring
      guide, migration note all updated.
- [ ] `deep-suite` cross-repo manifests updated (sha + description
      + artifacts/data_flow entries).

---

## 13. Cross-repo coordination (release-time)

1. Bump version in 3 manifests (`package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) → `0.3.0`. Manifest-drift CI gate enforces.
2. Update `CHANGELOG.md` + `CHANGELOG.ko.md` (Breaking section explicit on storage-version bump).
3. Update the local `deep-suite` checkout (dev-machine path varies — author's is `~/Dev/claude-plugins/deep-suite/`; release script should resolve via env var `DEEP_SUITE_ROOT` or CLI arg, not a hardcoded absolute path):
   - `marketplace.json` × 2 (sha + description)
   - `suite-extensions.json` (artifacts: add `hooks`, `mcp-server`; data_flow updated)
4. Update `README.md` + `README.ko.md` (new architecture diagram, MCP wiring guide, hook auto-capture explanation, migration note).
5. Commit this design doc (already done as part of brainstorming spec gate).

---

## 14. References

- v0.1.x roadmap & lessons: [`docs/handoff-phase-4-6.md`](../../handoff-phase-4-6.md)
- v0.1.x immediate follow-up (shipped): [`docs/handoff-v0.1.x-immediate.md`](../../handoff-v0.1.x-immediate.md)
- v0.2.0 sql.js track (prerequisite): [`docs/handoff-v0.2.0-sql-js-fallback.md`](../../handoff-v0.2.0-sql-js-fallback.md)
- CHANGELOG: [`CHANGELOG.md`](../../../CHANGELOG.md) / [`CHANGELOG.ko.md`](../../../CHANGELOG.ko.md)
- Reference upstream: https://github.com/rohitg00/agentmemory
   - README: https://github.com/rohitg00/agentmemory/blob/main/README.md
   - ROADMAP: https://github.com/rohitg00/agentmemory/blob/main/ROADMAP.md
   - License: Apache-2.0
- Schemas (v0.1.x, unchanged in v0.3.0): [`schemas/memory-card.schema.json`](../../../schemas/memory-card.schema.json), [`schemas/memory-event.schema.json`](../../../schemas/memory-event.schema.json), [`schemas/memory-card-distill-output.schema.json`](../../../schemas/memory-card-distill-output.schema.json), [`schemas/project-profile.schema.json`](../../../schemas/project-profile.schema.json)
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Embedding model: https://huggingface.co/Xenova/all-MiniLM-L6-v2
- Codex Desktop hooks issue: https://github.com/openai/codex/issues/16430

---

## 15. Open questions left to plan phase

These do not block the spec but should be answered when writing the
implementation plan (`writing-plans` skill):

1. **MCP SDK version pin** — `@modelcontextprotocol/sdk` is at ^1.x;
   confirm the exact stable version compatible with both Claude Code
   and Codex during plan writing.
2. **`@xenova/transformers` model fetch policy** — first run downloads
   ~80 MB to `~/.cache/huggingface`. Plan must decide: (a) prompt
   user on first embed call, or (b) bundle the model in plugin (size
   trade-off vs. install simplicity).
3. **Detector heuristic thresholds** — defaults in §4.2 are
   plausible-looking but need a small fixture sweep during
   `mapHookSession` implementation to verify they don't fire too
   often or too rarely on realistic sessions.
4. **sql.js read-mutex requirement** — §6.6 establishes that
   read-only access from a single Node process should be mutex-free,
   but sql.js's in-memory model is unusual; the plan phase must
   probe whether two concurrent JS-thread read calls (e.g. two MCP
   tool callbacks in the same server, microtask-interleaved) can
   corrupt sql.js's internal cursor state. If they can, the
   `truly lockless` tier of §6.6 needs a JS-level read mutex on the
   sql.js backend only (better-sqlite3 native binding remains
   mutex-free). This is the remaining concurrency ambiguity from
   R-010.

5. **events.jsonl rotation/archive strategy** (added R3-K) — for
   long-running users (capture.enabled: true accumulates ~100 MB/month),
   the spec defers archive support to v0.3.x. The plan phase must
   decide: (a) which rotation tool (logrotate, OS-native, deep-memory
   built-in?), (b) whether to read-through gzipped archives or require
   explicit decompression first, (c) cursor advancement semantics when
   archived files are involved.

6. **Host-side consent protocol** (added R3-N + R3-B option-c
   forward-compat) — v0.3.0 ships R3-B option (a): mutation MCP
   surface is slash-only. v0.3.x re-introduction of autonomous
   mutation requires a host-protocol agreement: server-issued nonce
   shape, consent_store persistence model, audit-log fingerprint
   integration. Either spec'd inside `deep-memory` and proposed
   upstream to Claude Code / Codex / Cursor as a shared MCP extension,
   or adopted from an existing standard if one emerges. Plan phase
   should record current upstream conventions for reference.

7. **Hook-append fallback during long rebuild** (added R3-H) — v0.3.0
   accepts that `/deep-memory-audit --rebuild-vectors` blocks hook
   append for the rebuild duration. Plan phase should decide: (a)
   does v0.3.x split `.rebuild.lock` from main `.lock`, (b) does
   hook script gain an in-memory buffer + deferred fsync path during
   detected long lock-hold, (c) does the spec advise users to run
   rebuild only during agent-idle windows.

(Earlier "hook latency probe" question — became §3.2.2's G-α/G-β
gates with explicit pass criteria; no longer "open". Earlier "MCP
read concurrency" — now narrowed to the sql.js-specific sub-question
above per R-010.)

---

*end of spec*
