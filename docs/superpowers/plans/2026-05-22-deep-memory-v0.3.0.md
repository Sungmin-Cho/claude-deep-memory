# deep-memory v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deep-memory v0.3.0 — agentmemory-style standalone-first overhaul per spec `docs/superpowers/specs/2026-05-22-deep-memory-v0.3.0-design.md` (4-round deep-review-loop graduated; 62 cumulative ACCEPT items).

**Architecture:** 3-layer (Capture → Distill → Retrieval) + MCP server surface. Hook-driven automatic capture writes raw observations to `events/YYYY-MM.jsonl` (new artifact_kind `memory-hook-event` co-existing with v0.1.x `memory-event`); artifact_kind dispatcher routes to per-schema validator + legacy flat-event adapter. Lazy distill pipeline produces 5 memory_type cards via Step A (6 mappers including new `mapHookSession` with 5 detectors + sessionSummary fallback) + Step B (LLM batched `refineBatch`, ajv strict). Retrieval = FTS5 + local vector (`@xenova/transformers` optional) fused with RRF (k=60) + existing 6-stage rerank. MCP stdio server exposes 10 read-only tools (mutation is slash-only per §6.3.1 Gates 2/3). Global lock split into short critical sections (cursor scan + commit) so LLM/embedding work never blocks hook append.

**Tech Stack:** Node 22 LTS, JS (no build step), `ajv` (existing), `better-sqlite3` (existing) + `sql.js` (v0.2.0 fallback), `@xenova/transformers` (NEW, optional), `@modelcontextprotocol/sdk@^1` (NEW, required).

**Status:** DRAFT — Plan-Round-1 deep-review-loop response applied (11 🔴 + 9 🟡 inline fixes; 4 ℹ️ deferred to `docs/handoff-v0.3.0-postrelease.md`). Round 2 verification pending.

**Prerequisites:**
- **v0.2.0 sql.js track must ship first** (separate PR chain per `docs/handoff-v0.2.0-sql-js-fallback.md`).
- **Pre-γ widening**: composite `(memory_id, project_id)` FTS5 + vector key (C-R1 fix). Preferred in v0.2.0; otherwise Task γ.1 is mandatory prerequisite within Phase 0.3.0-γ.
- **Phase 0 (Plan-Round-1 fix PR1-G)**: update `package.json` `"test"` script to include nested test directories AND fix the pre-existing manifest-drift baseline:
  ```json
  "scripts": {
    "test": "node --test tests/*.test.js tests/runtime-contract/*.test.js tests/hooks/*.test.js tests/mcp-tools/*.test.js"
  }
  ```
  Also add `description`/`author`/`license` to `.claude-plugin/plugin.json` so the existing `tests/manifest-drift.test.js` baseline turns green before α work begins (otherwise α.12's gate check is comparing against a pre-broken baseline). Verify with `node --test tests/manifest-drift.test.js`.

**Spec reference:** `docs/superpowers/specs/2026-05-22-deep-memory-v0.3.0-design.md` (1995 lines)

**Phase sequencing (gated by deep-review-loop per phase):**
| Phase | Tasks | Exit gate |
|---|---|---|
| 0.3.0-α | α.1 – α.13 | G-α-latency p95 ≤ 400 ms + dispatcher tests |
| 0.3.0-β | β.1 – β.10 | G-β-latency p95 ≤ 500 ms with concurrent brief |
| 0.3.0-γ | γ.1 – γ.7 | Hybrid retrieval (match + mismatch states) |
| 0.3.0-δ | δ.1 – δ.20 | MCP lifecycle + privacy gates |
| 0.3.0-ε | ε.1 – ε.6 | Migration roundtrip + downgrade safe |
| 0.3.0-final | final.1 – final.4 | Cross-repo green |

---

## File structure (new + modified)

### Schemas (new)

| File | Responsibility |
|---|---|
| `schemas/memory-hook-event.schema.json` | M3-envelope-wrapped hook event record (artifact_kind `memory-hook-event`); separate from existing `memory-event.schema.json` |
| `schemas/audit-log-entry.schema.json` | Uniform `{at, id, kind, by, host, payload}` envelope with `oneOf` per-kind payloads |

### Hook scripts (new — bundled in plugin)

| File | Responsibility |
|---|---|
| `scripts/hooks/common.mjs` | Shared: capture.enabled gate (R4-D), event normalization, dedupe_window_key, atomic append-only writer |
| `scripts/hooks/session-start.mjs` | `hook-session-start` event emitter |
| `scripts/hooks/user-prompt-submit.mjs` | `hook-user-prompt` event emitter |
| `scripts/hooks/post-tool-use.mjs` | `hook-post-tool-use` event emitter (main signal) |
| `scripts/hooks/post-tool-failure.mjs` | `hook-tool-failure` event emitter |
| `scripts/hooks/pre-compact.mjs` | `hook-pre-compact` + Eager distill enqueue (if `config.capture.eager_distill: true`) |
| `scripts/hooks/session-end.mjs` | `hook-session-end` + Eager distill enqueue |

### Lib modules (new + modify)

| File | Responsibility |
|---|---|
| `scripts/lib/redact.js` (modify) | Promote 3 path/env/stack rules to shared set (R-011) |
| `scripts/lib/event-dispatcher.js` (new) | artifact_kind dispatcher + legacy flat-event adapter (§3.4.4, R4-H) |
| `scripts/lib/cursor.js` (new) | Byte-offset cursor file r/w (`<file>:<offset>` format, cross-month rollover) |
| `scripts/lib/audit-log.js` (new) | Envelope writer (uniform shape per §6.3.1) |
| `scripts/lib/distill-hook-session.js` (new) | `mapHookSession` + 5 detectors + sessionSummary |
| `scripts/lib/llm-bridge.js` (modify) | Add `refineBatch()` for ≤5-draft batches; existing `refine()` unchanged |
| `scripts/lib/lock.js` (modify) | Split critical sections A (cursor scan) + B (commit) |
| `scripts/lib/embed-model.js` (new) | `@xenova/transformers` lazy load + `.embed-model-version` check (R3-G + R4-I try-catch) |
| `scripts/lib/vector-index.js` (new) | `indexes/vector.sqlite` schema + brute-force cosine search |
| `scripts/lib/rrf-fusion.js` (new) | RRF k=60 fusion over FTS5 + vector candidate sets |
| `scripts/lib/score.js` (modify) | 6-stage rerank Stage 8 — add `session_id` diversification |
| `scripts/lib/fts-index.js` (modify) | Keep existing API; coordinate with vector for hybrid; no schema change |
| `scripts/lib/privacy-gate.js` (new) | Gate 1/2/3 enforcement + structured error responses |
| `scripts/lib/legacy-adapter.js` (new) | Wraps v0.1.x flat events into envelope/payload at read time (R4-H) |

### Entry scripts (new + modify)

| File | Responsibility |
|---|---|
| `scripts/mcp-server.mjs` (new) | stdio MCP server entry (~200 LOC); imports CommonJS lib via dynamic `import()` |
| `scripts/save.js` (new) | `deep_memory_save` implementation (autonomous: privacy='local' only) |
| `scripts/forget.js` (new) | `deep_memory_forget` (slash-only soft-delete + audit-log) |
| `scripts/export.js` (new) | `deep_memory_export` (autonomous current-project; slash cross-project) |
| `scripts/init.js` (modify) | Multi-marker storage-version detection (R3-D + R4-J) + capture-default policy (R4-D + §3.6) |
| `scripts/harvest.js` (modify) | Add Lazy distill + Stage 0a + dual-artifact dispatcher; existing 5-mapper path unchanged |
| `scripts/retrieve.js` (modify) | Add Vector + RRF + privacy gate; existing FTS5 path becomes one of 2 streams |
| `scripts/brief.js` (modify) | Stage 0a Lazy distill before retrieval format |
| `scripts/audit.js` (modify) | Add `--rebuild-vectors`, `--reset-cursor`, `--rebuild-version-marker`; restrict MCP autonomous to `mode='check'` |

### Skills (new + modify)

| File | Responsibility |
|---|---|
| `skills/deep-memory-remember/SKILL.md` (new) | Slash: explicit save via `scripts/save.js` |
| `skills/deep-memory-recall/SKILL.md` (new) | Slash: lightweight lexical recall |
| `skills/deep-memory-forget/SKILL.md` (new) | Slash: soft-delete |
| `skills/deep-memory-export/SKILL.md` (new) | Slash: cross-project export + audit-log |
| `skills/deep-memory-audit/SKILL.md` (modify) | Restrict autonomous MCP to `--check`; slash supports all modes |

### Manifests (modify)

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | + `hooks` (6 Tier-1), + inline `mcpServers` entry |
| `.codex-plugin/plugin.json` | + `hooks` (4 Codex-supported subset), `"mcpServers": "./.mcp.json"` (R4-G path form) |
| `.mcp.json` (new) | Codex MCP entry pointing at `scripts/mcp-server.mjs` |
| `package.json` | + `@modelcontextprotocol/sdk@^1` (dep), + `@xenova/transformers@^2.17.2` (optionalDeps) |

### Tests (new + modify)

| File | Responsibility |
|---|---|
| `tests/hooks/common.test.js` | Capture.enabled gate (R4-D) |
| `tests/hooks/session-start.test.js` | Stdin fixture → events.jsonl |
| `tests/hooks/user-prompt-submit.test.js` | Stdin → events.jsonl + Pass 0 redaction |
| `tests/hooks/post-tool-use.test.js` | Stdin → events.jsonl, 3 hosts (claude-code, codex) |
| `tests/hooks/post-tool-failure.test.js` | failure-case routing |
| `tests/hooks/pre-compact.test.js` | Eager distill enqueue (if enabled) |
| `tests/hooks/session-end.test.js` | Eager distill enqueue + back-to-back fire test |
| `tests/redact-pass-0-shared.test.js` | 5 redaction classes promoted to shared (R-011) |
| `tests/event-dispatcher.test.js` | artifact_kind routing + quarantine edge cases (R2-M, R4-H) |
| `tests/legacy-adapter.test.js` | v0.1.x flat events wrap correctly (R4-H fixture) |
| `tests/cursor.test.js` | Byte-offset r/w + rollover + token-cap deferred reachability (R4-B) |
| `tests/distill-hook-session.test.js` | 5 detectors + sessionSummary + zero-output |
| `tests/distill-trigger-lazy.test.js` | Stage 0a integration + idempotency |
| `tests/refine-batch.test.js` | Batch refine, schema validation, per-draft fallback |
| `tests/lock-split.test.js` | Lock granularity invariant (R3-H + §4.5) |
| `tests/fire-and-forget.test.js` | Detach + unref + heartbeat + back-to-back coalesce (§3.2.1) |
| `tests/vector-index.test.js` | embed → store → cosine → rank (8 tests) |
| `tests/embed-model-mismatch.test.js` | `.embed-model-version` abort path (R-006 + R4-I) |
| `tests/rrf-fusion.test.js` | 4 fusion scenarios (FTS-only / vector-only / both / empty) |
| `tests/rerank-session-diversification.test.js` | Stage 8 session cap (R-010) |
| `tests/graceful-degrade.test.js` | @xenova absent + lexical-only matrix |
| `tests/cross-project-filter.test.js` | R4-C interleaved-project fixture |
| `tests/capture-enabled-gate.test.js` | R4-D 30 fires with disabled |
| `tests/mcp-server-lifecycle.test.js` | spawn → multi-call → EOF → lease cleanup |
| `tests/mcp-tools/*.test.js` | One file per tool (10 tools × 2 paths = ~20 tests) |
| `tests/privacy-gates.test.js` | Gate 1/2/3 enforcement + envelope error shapes (R4-F) |
| `tests/audit-log-envelope.test.js` | All 10 `kind` values validate (R3-J + R4-E) |
| `tests/migration.test.js` | v0.2.x mock → init → vector rebuild + multi-card detection (R4-J) |
| `tests/downgrade-safe.test.js` | v0.3.0 → v0.2.x card readability |
| `tests/g-alpha-latency.test.js` | 30 fires p95 ≤ 400 ms with fixture (R2-N, R4-F) |
| `tests/g-beta-latency.test.js` | Concurrent brief + 30 fires p95 ≤ 500 ms |
| `tests/sibling-shape-smoke.test.js` (existing) | unchanged |
| `tests/fixtures/hooks/*.jsonl` (new) | Per-hook recorded stdin |
| `tests/fixtures/hooks/g-alpha-macro.jsonl` (new) | R2-N benchmark fixture |
| `tests/fixtures/sessions/*.jsonl` (new) | mapHookSession fixtures |
| `tests/fixtures/legacy/v01x-flat-event.jsonl` (new) | R4-H legacy adapter fixture |
| `tests/fixtures/mcp-payloads/*.json` (new) | JSON-RPC per tool |
| `tests/fixtures/audit-log-samples/*.jsonl` (new) | 10 sample entries × 5+ kinds |

### CI / Docs

| File | Responsibility |
|---|---|
| `.github/workflows/ci.yml` (modify) | 4-cell matrix: `DEEP_MEMORY_FTS_BACKEND ∈ {better-sqlite3, sqljs}` × `@xenova ∈ {installed, absent}` |
| `CHANGELOG.md` + `CHANGELOG.ko.md` (modify) | v0.3.0 entry — Breaking section |
| `README.md` + `README.ko.md` (modify) | Architecture diagram + MCP wiring guide + migration note |
| `docs/handoff-v0.3.0-postrelease.md` (new) | v0.3.x post-release backlog (open §15 questions: archive, host consent, rebuild-lock split) |

---

# Phase 0.3.0-α — Hook Scripts + Pass 0 Redaction + Schemas

**Gate**: G-α-latency macrobenchmark (30 fires p95 ≤ 400 ms) + dispatcher tests pass + manifest-drift CI green.

### Task α.1: Add `memory-hook-event.schema.json`

**Files:**
- Create: `schemas/memory-hook-event.schema.json`
- Test: `tests/event-dispatcher.test.js` (Step 1 writes a fixture using this schema)

- [ ] **Step 1: Write failing test asserting schema exists and validates a known-good record**

```js
// tests/event-dispatcher.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');

test('memory-hook-event schema validates valid record', () => {
  const schema = JSON.parse(fs.readFileSync('schemas/memory-hook-event.schema.json', 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const rec = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: '01J0XKMRWQ7B9YZ8AE6F3VHTN5',
      generated_at: '2026-05-22T07:14:32.811Z',
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'host-stdin://claude-code/PostToolUse' }] },
      host: 'claude-code',
      session_id: 'claude-cc-7a3f',
      project_id: 'proj_8e2c'
    },
    payload: {
      source_kind: 'hook-post-tool-use',
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: '2026-05-22T07:14:32.811Z',
      tool_name: 'Edit',
      tool_input_summary: 'edited src/auth.ts',
      tool_output_summary: '12 lines changed',
      raw_chars_in: 4321,
      raw_chars_out: 1024,
      redaction: { rules_matched: 1, chars_masked: 18, passes: ['pass0'] }
    }
  };
  assert.ok(validate(rec), JSON.stringify(validate.errors));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/event-dispatcher.test.js 2>&1 | head -30
```

Expected: FAIL with `ENOENT: no such file or directory, open 'schemas/memory-hook-event.schema.json'`

- [ ] **Step 3: Create the schema file**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Sungmin-Cho/claude-deep-memory/schemas/memory-hook-event.schema.json",
  "title": "Memory Hook Event",
  "type": "object",
  "required": ["schema_version", "envelope", "payload"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "const": "1.0" },
    "envelope": {
      "type": "object",
      "required": ["producer", "producer_version", "artifact_kind", "run_id", "generated_at", "schema", "git", "provenance", "host", "session_id", "project_id"],
      "additionalProperties": false,
      "properties": {
        "producer": { "const": "deep-memory" },
        "producer_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
        "artifact_kind": { "const": "memory-hook-event" },
        "run_id": { "type": "string", "minLength": 1 },
        "generated_at": { "type": "string", "format": "date-time" },
        "schema": { "type": "object", "required": ["name", "version"], "additionalProperties": false, "properties": { "name": { "const": "memory-hook-event" }, "version": { "type": "string" } } },
        "git": { "type": "object", "additionalProperties": false, "properties": { "head": { "type": "string" }, "branch": { "type": "string" }, "dirty": { "type": "string" } } },
        "provenance": { "type": "object", "required": ["source_artifacts"], "additionalProperties": false, "properties": { "source_artifacts": { "type": "array", "items": { "type": "object", "required": ["path"], "additionalProperties": false, "properties": { "path": { "type": "string", "minLength": 1 }, "run_id": { "type": "string" } } } } } },
        "host": { "type": "string", "enum": ["claude-code", "codex", "cursor", "gemini-cli", "cline", "(other)"] },
        "session_id": { "type": "string", "minLength": 1 },
        "project_id": { "type": "string", "minLength": 1 }
      }
    },
    "payload": {
      "type": "object",
      "required": ["source_kind", "event_key", "dedupe_window_key", "captured_at", "raw_chars_in", "raw_chars_out", "redaction"],
      "additionalProperties": false,
      "properties": {
        "source_kind": { "enum": ["hook-session-start", "hook-user-prompt", "hook-post-tool-use", "hook-tool-failure", "hook-pre-compact", "hook-session-end"] },
        "event_key": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "dedupe_window_key": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
        "captured_at": { "type": "string", "format": "date-time" },
        "tool_name": { "type": "string" },
        "tool_input_summary": { "type": "string" },
        "tool_output_summary": { "type": "string" },
        "raw_chars_in": { "type": "integer", "minimum": 0 },
        "raw_chars_out": { "type": "integer", "minimum": 0 },
        "redaction": { "type": "object", "required": ["rules_matched", "chars_masked", "passes"], "additionalProperties": false, "properties": { "rules_matched": { "type": "integer", "minimum": 0 }, "chars_masked": { "type": "integer", "minimum": 0 }, "passes": { "type": "array", "items": { "enum": ["pass0", "pass1", "pass2", "pass3"] } } } }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/event-dispatcher.test.js 2>&1 | head -10
```

Expected: PASS (`# pass 1, # fail 0`)

- [ ] **Step 5: Commit**

```bash
git add schemas/memory-hook-event.schema.json tests/event-dispatcher.test.js
git commit -m "feat(α.1): add memory-hook-event.schema.json (R-001 dual artifact_kind)"
```

---

### Task α.2: Add `audit-log-entry.schema.json` (oneOf-validated envelope)

**Files:**
- Create: `schemas/audit-log-entry.schema.json`
- Test: `tests/audit-log-envelope.test.js`

- [ ] **Step 1: Write failing test**

```js
// tests/audit-log-envelope.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');

test('audit-log envelope validates 10 kind variants', () => {
  const schema = JSON.parse(fs.readFileSync('schemas/audit-log-entry.schema.json', 'utf8'));
  const ajv = new Ajv({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const samples = [
    { at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'capture-toggle', by: 'slash-direct', host: 'claude-code', payload: { from: false, to: true, method: 'prompted' } },
    { at: '2026-05-22T00:00:01Z', id: '01H2', kind: 'cross-project-read', by: 'slash-direct', host: 'claude-code', payload: { scope: 'all', projects_read: ['p1', 'p2'], tool: 'brief' } },
    { at: '2026-05-22T00:00:02Z', id: '01H3', kind: 'mutation-consent', by: 'slash-direct', host: 'claude-code', payload: { tool: 'unlock', args: {} } },
    { at: '2026-05-22T00:00:03Z', id: '01H4', kind: 'gate-violation', by: 'mcp-autonomous', host: 'codex', payload: { tool: 'audit', requested_scope: 'unlock', denial_reason: 'gate2', error: 'slash_only_in_v030' } },
    { at: '2026-05-22T00:00:04Z', id: '01H5', kind: 'save', by: 'mcp-autonomous', host: 'cursor', payload: { memory_id: 'mem_x', memory_type: 'pattern', privacy: 'local' } },
    { at: '2026-05-22T00:00:05Z', id: '01H6', kind: 'forget', by: 'slash-direct', host: 'claude-code', payload: { memory_id: 'mem_y', reason: 'deprecated' } },
    { at: '2026-05-22T00:00:06Z', id: '01H7', kind: 'cross-project-export', by: 'slash-direct', host: 'claude-code', payload: { scope: 'all', exported_count: 42, target_path: '/tmp/x.json' } },
    { at: '2026-05-22T00:00:07Z', id: '01H8', kind: 'promote', by: 'slash-direct', host: 'claude-code', payload: { memory_id: 'mem_z', from_privacy: 'local', to_privacy: 'global' } },
    { at: '2026-05-22T00:00:08Z', id: '01H9', kind: 'rebuild', by: 'slash-direct', host: 'claude-code', payload: { index: 'vector', cards_processed: 50, duration_ms: 8000 } },
    { at: '2026-05-22T00:00:09Z', id: '01HA', kind: 'unlock', by: 'slash-direct', host: 'claude-code', payload: { lock_holder_pid: 1234, stale_for_seconds: 320 } }
  ];
  for (const s of samples) {
    assert.ok(validate(s), `${s.kind}: ${JSON.stringify(validate.errors)}`);
  }
});
```

- [ ] **Step 2: Verify FAIL**

```bash
node --test tests/audit-log-envelope.test.js
```

Expected: FAIL (schema file missing).

- [ ] **Step 3: Write schema with oneOf**

Create `schemas/audit-log-entry.schema.json` with envelope `{at,id,kind,by,host,payload}` and `oneOf` discriminated by `kind` (10 enum values per §6.3.1 audit-log envelope block). Each `kind` variant has its own `payload` shape.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Sungmin-Cho/claude-deep-memory/schemas/audit-log-entry.schema.json",
  "title": "Audit Log Entry",
  "type": "object",
  "required": ["at", "id", "kind", "by", "host", "payload"],
  "additionalProperties": false,
  "properties": {
    "at": { "type": "string", "format": "date-time" },
    "id": { "type": "string", "minLength": 1 },
    "kind": { "enum": ["capture-toggle", "cross-project-read", "mutation-consent", "gate-violation", "save", "forget", "cross-project-export", "promote", "rebuild", "unlock"] },
    "by": { "enum": ["slash-direct", "mcp-autonomous", "hook-script", "init-migration", "cli-flag"] },
    "host": { "type": "string" },
    "payload": { "type": "object" }
  },
  "oneOf": [
    { "properties": { "kind": { "const": "capture-toggle" }, "payload": { "type": "object", "required": ["from", "to", "method"], "additionalProperties": false, "properties": { "from": { "type": "boolean" }, "to": { "type": "boolean" }, "method": { "enum": ["prompted", "cli-flag", "non-interactive-default"] } } } } },
    { "properties": { "kind": { "const": "cross-project-read" }, "payload": { "type": "object", "required": ["scope", "projects_read", "tool"], "additionalProperties": false, "properties": { "scope": { "const": "all" }, "projects_read": { "type": "array", "items": { "type": "string" } }, "tool": { "enum": ["brief", "smart_search", "recall"] } } } } },
    { "properties": { "kind": { "const": "mutation-consent" }, "payload": { "type": "object", "required": ["tool", "args"], "additionalProperties": false, "properties": { "tool": { "enum": ["audit", "promote", "forget", "rebuild-index", "rebuild-vectors", "unlock"] }, "args": { "type": "object" } } } } },
    { "properties": { "kind": { "const": "gate-violation" }, "payload": { "type": "object", "required": ["tool", "requested_scope", "denial_reason", "error"], "additionalProperties": false, "properties": { "tool": { "type": "string" }, "requested_scope": { "type": "string" }, "denial_reason": { "enum": ["gate1", "gate2", "gate3"] }, "error": { "type": "string" } } } } },
    { "properties": { "kind": { "const": "save" }, "payload": { "type": "object", "required": ["memory_id", "memory_type", "privacy"], "additionalProperties": false, "properties": { "memory_id": { "type": "string" }, "memory_type": { "type": "string" }, "privacy": { "const": "local" } } } } },
    { "properties": { "kind": { "const": "forget" }, "payload": { "type": "object", "required": ["memory_id", "reason"], "additionalProperties": false, "properties": { "memory_id": { "type": "string" }, "reason": { "type": "string" } } } } },
    { "properties": { "kind": { "const": "cross-project-export" }, "payload": { "type": "object", "required": ["scope", "exported_count", "target_path"], "additionalProperties": false, "properties": { "scope": { "type": "string" }, "exported_count": { "type": "integer", "minimum": 0 }, "target_path": { "type": "string" } } } } },
    { "properties": { "kind": { "const": "promote" }, "payload": { "type": "object", "required": ["memory_id", "from_privacy", "to_privacy"], "additionalProperties": false, "properties": { "memory_id": { "type": "string" }, "from_privacy": { "const": "local" }, "to_privacy": { "const": "global" } } } } },
    { "properties": { "kind": { "const": "rebuild" }, "payload": { "type": "object", "required": ["index", "cards_processed", "duration_ms"], "additionalProperties": false, "properties": { "index": { "enum": ["lexical", "vector"] }, "cards_processed": { "type": "integer", "minimum": 0 }, "duration_ms": { "type": "integer", "minimum": 0 } } } } },
    { "properties": { "kind": { "const": "unlock" }, "payload": { "type": "object", "required": ["lock_holder_pid", "stale_for_seconds"], "additionalProperties": false, "properties": { "lock_holder_pid": { "type": "integer" }, "stale_for_seconds": { "type": "integer", "minimum": 0 } } } } }
  ]
}
```

- [ ] **Step 4: Verify PASS**

```bash
node --test tests/audit-log-envelope.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schemas/audit-log-entry.schema.json tests/audit-log-envelope.test.js
git commit -m "feat(α.2): add audit-log-entry.schema.json (R3-J envelope, 10 kinds)"
```

---

### Task α.3: Promote 3 path/env/stack redaction rules to shared set (R-011)

**Files:**
- Modify: `scripts/lib/redact.js`
- Test: `tests/redact-pass-0-shared.test.js`

- [ ] **Step 1: Write failing test for the 3 new shared rules**

```js
// tests/redact-pass-0-shared.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { redactString } = require('../scripts/lib/redact');

test('path normalization: /Users/<u> → ~/', () => {
  const r = redactString('error at /Users/alice/Dev/repo/src/auth.ts:42');
  assert.ok(r.includes('~/Dev/repo/src/auth.ts:42'), `got: ${r}`);
  assert.ok(!r.includes('/Users/alice'), `leak: ${r}`);
});

test('env var redaction: $AGENTMEMORY_SECRET masked', () => {
  const r = redactString('export AGENTMEMORY_SECRET=abc123def');
  assert.ok(r.includes('<REDACTED>') || !r.includes('abc123def'), `got: ${r}`);
});

test('stack trace homedir redacted', () => {
  const stack = 'Error: x\n    at Object.<anonymous> (/Users/alice/Dev/proj/src/foo.js:10:5)';
  const r = redactString(stack);
  assert.ok(!r.includes('/Users/alice'), `leak: ${r}`);
  assert.ok(r.includes('~/'), `not normalized: ${r}`);
});
```

- [ ] **Step 2: Verify FAIL**

```bash
node --test tests/redact-pass-0-shared.test.js
```

- [ ] **Step 3: Extend `scripts/lib/redact.js` — 3 R-011 shared rules wired into the existing `redactString` pipeline (PR1-E fix)**

**Context** (verified by reading current `scripts/lib/redact.js`): the existing module already has `HOME_RE` masking current `os.homedir()` → `~` (line 43) and 7 `DENY_PATTERNS` (lines 20–28). The R-011 promotion adds: (a) **generic** `/Users/<name>` / `/home/<name>` masking (HOME_RE only covers the CURRENT runner; we also need to mask other users' paths captured in cross-machine fixtures or shared stack traces), (b) env-var assignment masking that PRESERVES the variable name and only redacts the value, (c) stack-trace homedir coverage (already covered by HOME_RE + generic homedir transforms when stacks contain absolute paths).

Modify `scripts/lib/redact.js`:

```js
// scripts/lib/redact.js — PR1-E (R-011) extension. Wire into existing
// redactString pipeline; SHARED_RULES dead-code structure from earlier draft
// is removed in favor of stage-ordered transforms.

// 1) Add to DENY_PATTERNS array (after line 28):
DENY_PATTERNS.push(
  // (existing 7 patterns retained)
);

// 2) Add transforms applied in stage order. These run BEFORE DENY_PATTERNS so
//    paths/env-vars are converted to readable forms (~/, $VAR=<REDACTED>)
//    instead of being globally REDACT_TAG'd.

// PR1-E (a): generic homedir → ~ (any user, any platform).
function applyGenericHomedir(s) {
  return s
    .replace(/\/Users\/[a-zA-Z0-9_.-]+/g, '~')      // macOS
    .replace(/\/home\/[a-zA-Z0-9_.-]+/g,  '~');     // Linux
}

// PR1-E (b): env-var assignment masking. Matches `$VAR`, `process.env.VAR`,
//   `export VAR=...`, and BARE `VAR=...` (the W3 bare-assignment fix). Value
//   is replaced with <REDACTED>; the variable name is preserved for context.
//   Only sensitive prefixes are covered (no generic 3-letter env vars).
const SENSITIVE_VAR_RE = /((?:\$|process\.env\.|\bexport\s+)?(?:AGENTMEMORY|AWS|OPENAI|ANTHROPIC|GOOGLE|STRIPE|GITHUB)_[A-Z_]+)(\s*=\s*['"]?[\w./+\-]+['"]?)?/g;
function applyEnvVarRedaction(s) {
  return s.replace(SENSITIVE_VAR_RE, (_m, varRef, assignment) =>
    assignment ? `${varRef}=<REDACTED>` : varRef);
}

// 3) Modify redactString (current line 41-58) to thread the new transforms.
function redactString(input, { allowPatterns = [] } = {}) {
  if (typeof input !== 'string') return input;
  let out = input.replace(HOME_RE, '~');     // current runner's homedir
  out = applyGenericHomedir(out);            // PR1-E (a) — any-user homedir
  out = applyEnvVarRedaction(out);           // PR1-E (b) — env-var assignments
  for (const re of DENY_PATTERNS) {
    out = out.replace(re, REDACT_TAG);
  }
  for (const allow of allowPatterns) {       // existing allow-pattern logic unchanged
    const allowRe = new RegExp(allow, 'g');
    if (allowRe.test(input)) {
      const matches = input.match(allowRe) || [];
      for (const m of matches) out = out.replace(REDACT_TAG, m);
    }
  }
  return out;
}
```

**Test fixture portability (W2 fix)**: the test in Step 1 uses `/Users/alice/...` (other user, not the runner). The new `applyGenericHomedir` rule covers any `/Users/<name>/` path independent of `os.homedir()`, so the fixture is portable across CI runners + dev machines without needing `os.homedir()` interpolation. Add a single Linux fixture (`/home/runner/...`) to the test to verify cross-platform coverage.

- [ ] **Step 4: Verify PASS**

```bash
node --test tests/redact-pass-0-shared.test.js
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/redact.js tests/redact-pass-0-shared.test.js
git commit -m "feat(α.3): promote path/env/stack rules to shared redact set (R-011)"
```

---

### Task α.4: Hook script common helper — capture.enabled gate + atomic append

**Files:**
- Create: `scripts/hooks/common.mjs`
- Test: `tests/capture-enabled-gate.test.js`

- [ ] **Step 1: Write failing test (capture.enabled=false → no append)**

```js
// tests/capture-enabled-gate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('hook with capture.enabled=false leaves events.jsonl unchanged (R4-D)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'events'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'), 'capture:\n  enabled: false\n');
  const before = fs.existsSync(path.join(tmpRoot, 'events/2026-05.jsonl')) ? fs.statSync(path.join(tmpRoot, 'events/2026-05.jsonl')).size : 0;
  const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, session_id: 's1' }),
    env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
    encoding: 'utf8'
  });
  assert.strictEqual(r.status, 0);
  const after = fs.existsSync(path.join(tmpRoot, 'events/2026-05.jsonl')) ? fs.statSync(path.join(tmpRoot, 'events/2026-05.jsonl')).size : 0;
  assert.strictEqual(after, before, 'events file should be unchanged');
});
```

- [ ] **Step 2: Verify FAIL**

```bash
node --test tests/capture-enabled-gate.test.js
```

- [ ] **Step 3: Implement `scripts/hooks/common.mjs`**

```js
// scripts/hooks/common.mjs (PR1-B/C/D/J + W4/W8 integrated)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { redactString } = require('../lib/redact.js');
// PR1-B: use existing lock.js API (acquire/release). β.8 introduces short-lock
// semantic in lock.js — for α.4 this is the SAME function, just with caller
// discipline of holding briefly (fsync+rename only).
const { acquire, release } = require('../lib/lock.js');

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

let configCache = null;  // { mtime, value }

function readConfig() {
  const cfgPath = path.join(DEEP_MEMORY_ROOT, 'config.yaml');
  try {
    const stat = fs.statSync(cfgPath);
    if (configCache && configCache.mtime === stat.mtimeMs) return configCache.value;
    const text = fs.readFileSync(cfgPath, 'utf8');
    const enabled = /capture:\s*\n\s*enabled:\s*true/.test(text);  // simple YAML probe
    configCache = { mtime: stat.mtimeMs, value: { capture: { enabled } } };
    return configCache.value;
  } catch (e) {
    return { capture: { enabled: false } };  // safe default
  }
}

export function isCaptureEnabled() {
  return readConfig().capture.enabled === true;
}

// PR1-C: resolve current project from cwd / project-profile.json.
// Hook stdin payloads don't include project_id — derive it here.
export function resolveCurrentProject() {
  const cwd = process.env.PROJECT_CWD || process.cwd();
  const profilePath = path.join(cwd, '.deep-memory', 'project-profile.json');
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.project_id) return profile.project_id;
  } catch (e) {
    // fall through to derived id
  }
  return 'proj_' + crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

// PR1-J: derive tool summaries from raw tool_input/output (not from
// pre-existing summary fields hook stdin doesn't carry).
function summarizeToolInput(toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'string') return toolInput.slice(0, 200);
  if (toolInput.file_path) {
    const op = toolInput.old_string && toolInput.new_string ? 'edited' : 'wrote';
    const lines = toolInput.new_string ? toolInput.new_string.split('\n').length : '?';
    return `${op} ${toolInput.file_path} (${lines} lines)`;
  }
  if (toolInput.command) return `bash: ${toolInput.command.slice(0, 120)}`;
  if (toolInput.pattern) return `grep: ${toolInput.pattern.slice(0, 80)}`;
  return JSON.stringify(toolInput).slice(0, 200);
}

function summarizeToolOutput(toolOutput) {
  if (!toolOutput) return '';
  const s = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
  return s.slice(0, 300);
}

// PR1-J: 5-min sliding dedupe-window check (R-spec §3.2 step 4).
// Returns true if the dedupeKey has been seen for this project within 5 min.
function checkDedupeWindow(dedupeKey, projectId) {
  const indexPath = path.join(DEEP_MEMORY_ROOT, '.dedupe-window', `${projectId}.jsonl`);
  if (!fs.existsSync(indexPath)) return false;
  try {
    const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const line of lines) {
      const [key, atStr] = line.split('|');
      if (key === dedupeKey && parseInt(atStr, 10) >= cutoff) return true;
    }
  } catch {}
  return false;
}

function recordDedupeWindow(dedupeKey, projectId) {
  const indexDir = path.join(DEEP_MEMORY_ROOT, '.dedupe-window');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.appendFileSync(path.join(indexDir, `${projectId}.jsonl`), `${dedupeKey}|${Date.now()}\n`);
}

export async function normalizeAndAppend(sourceKind, hookPayload, hostHint) {  // PR2-B: async because lock acquire is async
  // Caller MUST also gate before stdin read (PR1-D); we double-check here.
  if (!isCaptureEnabled()) return { skipped: true, reason: 'capture-disabled' };
  // PR1-C: resolve project_id deterministically from cwd, not from payload.
  const projectId = resolveCurrentProject();
  // PR1-J: tool summaries derived from raw tool_input/output.
  const toolInputSummary = summarizeToolInput(hookPayload.tool_input);
  const toolOutputSummary = summarizeToolOutput(hookPayload.tool_output);
  // Pass 0: redact the assembled normalized payload (Pass 0 covers everything
  // about to be persisted, not just the raw stdin).
  const preRedacted = {
    source_kind: sourceKind,
    session_id: hookPayload.session_id || 'unknown',
    project_id: projectId,
    tool_name: hookPayload.tool_name || '',
    tool_input_summary: toolInputSummary,
    tool_output_summary: toolOutputSummary,
  };
  const redactedJson = redactString(JSON.stringify(preRedacted));
  const redactedPayload = JSON.parse(redactedJson);
  // PR1-J: event_key + dedupe_window_key are sha256(essence). NO Date.now in
  // essence — that defeats the 5-min sliding dedup. event_key includes
  // captured_at for forward distinguishability; dedupe_window_key omits it.
  // PR2-C: dedupe by HASH OF RAW (redacted) tool_input/output essence, not the
  // lossy summary. Two distinct edits to the same file in the same minute would
  // share `tool_input_summary` ("edited X.ts (12 lines)") and collide; using the
  // raw redacted content separates them.
  const rawEssenceInput = JSON.stringify(hookPayload.tool_input || '');
  const rawEssenceOutput = JSON.stringify(hookPayload.tool_output || '').slice(0, 1024);
  // Redact the essence components before hashing — Pass 0 invariant.
  const redactedEssenceIn = redactString(rawEssenceInput);
  const redactedEssenceOut = redactString(rawEssenceOutput);
  const essence = `${sourceKind}|${redactedPayload.session_id}|${redactedPayload.tool_name}|${redactedEssenceIn}|${redactedEssenceOut}`;
  const dedupeKey = crypto.createHash('sha256').update(essence).digest('hex');
  // PR1-J: 5-min sliding window — skip if same dedupeKey seen recently.
  if (checkDedupeWindow(dedupeKey, projectId)) {
    return { skipped: true, reason: 'duplicate-within-5min', dedupe_window_key: dedupeKey };
  }
  const capturedAt = new Date().toISOString();
  const eventKey = crypto.createHash('sha256').update(essence + '|' + capturedAt).digest('hex');
  const record = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: crypto.randomUUID(),
      generated_at: capturedAt,
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: `host-stdin://${hostHint}/${sourceKind}` }] },
      host: hostHint,
      session_id: redactedPayload.session_id,
      project_id: projectId
    },
    payload: {
      source_kind: sourceKind,
      event_key: eventKey,
      dedupe_window_key: dedupeKey,
      captured_at: capturedAt,
      tool_name: redactedPayload.tool_name,
      tool_input_summary: redactedPayload.tool_input_summary,
      tool_output_summary: redactedPayload.tool_output_summary,
      raw_chars_in: (JSON.stringify(hookPayload.tool_input || '')).length,
      raw_chars_out: (JSON.stringify(hookPayload.tool_output || '')).length,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  };
  // Atomic short-lock append — PR1-W4: open/write/fsync/close pattern (no fd leak)
  const ym = capturedAt.slice(0, 7);
  const eventsFile = path.join(DEEP_MEMORY_ROOT, 'events', `${ym}.jsonl`);
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  // PR2-B: acquire() expects the .lock directory path AND is async.
  // Existing scripts/lib/lock.js#acquire signature is `async function acquire(lockDir)`.
  const lockHandle = await acquire(path.join(DEEP_MEMORY_ROOT, '.lock'));  // PR1-B+PR2-B
  try {
    const fd = fs.openSync(eventsFile, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    recordDedupeWindow(dedupeKey, projectId);
  } finally {
    release(lockHandle);
  }
  return { appended: true, event_key: eventKey };
}

// PR1-W8: extend host detection. Schema enum and detectHost() now agree on
// the 6-value set (claude-code, codex, cursor, gemini-cli, cline, (other)).
export function detectHost() {
  if (process.env.CURSOR_PLUGIN_ROOT) return 'cursor';
  if (process.env.GEMINI_CLI_ROOT) return 'gemini-cli';
  if (process.env.CLINE_PLUGIN_ROOT) return 'cline';
  if (process.env.CLAUDE_PLUGIN_ROOT && process.env.CLAUDE_PLUGIN_ROOT.includes('claude')) return 'claude-code';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  return '(other)';
}
```

- [ ] **Step 4: Stub `scripts/hooks/post-tool-use.mjs` — capture gate BEFORE stdin read (PR1-D)**

```js
// scripts/hooks/post-tool-use.mjs (minimal stub for α.4 test)
import { isCaptureEnabled, normalizeAndAppend, detectHost } from './common.mjs';

// PR1-D: capture.enabled gate runs BEFORE any stdin read. Spec §3.2 step 0
// invariant — never read host payload when user opted out. Implement the same
// gate in every hook script (α.5-α.10 must mirror this header).
if (!isCaptureEnabled()) {
  process.exit(0);  // drop the hook event silently; host treats exit-0 as ack
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
normalizeAndAppend('hook-post-tool-use', input, detectHost());
process.exit(0);
```

- [ ] **Step 5: Verify PASS**

```bash
node --test tests/capture-enabled-gate.test.js
```

- [ ] **Step 6: Commit**

```bash
git add scripts/hooks/common.mjs scripts/hooks/post-tool-use.mjs tests/capture-enabled-gate.test.js
git commit -m "feat(α.4): hook common helper + capture.enabled gate (R4-D)"
```

---

### Tasks α.5–α.10: Per-hook scripts (5 more — same pattern as α.4 stub)

For each of `session-start.mjs`, `user-prompt-submit.mjs`, `post-tool-failure.mjs`, `pre-compact.mjs`, `session-end.mjs`:

**Pattern per task:**
- [ ] Write `tests/hooks/<name>.test.js` — fixture input, asserts `events/YYYY-MM.jsonl` gets one line with correct `source_kind`.
- [ ] Verify FAIL.
- [ ] Implement `scripts/hooks/<name>.mjs` using `common.mjs#normalizeAndAppend` with the correct `source_kind`. For `pre-compact.mjs` and `session-end.mjs`, also enqueue Eager distill if `config.capture.eager_distill: true` (use `child_process.spawn({ detached: true }) + child.unref()` per §3.2.1 invariant 1).
- [ ] Verify PASS.
- [ ] Commit `feat(α.N): hook <name>.mjs (<source_kind>)`.

**Eager distill enqueue** (only in `pre-compact.mjs` and `session-end.mjs`):

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// PR2-D: harvest.js --source enum is `siblings | all` (R-014 removed `hooks`).
// Eager hook distill goes through harvest.js with `--rebuild-from-events` flag
// (the dedicated retroactive hook-events re-distill path documented in §4.3).
const distillScript = fileURLToPath(new URL('../harvest.js', import.meta.url));
const child = spawn('node', [distillScript, '--rebuild-from-events', '--session', sessionId], {
  detached: true, stdio: 'ignore'
});
child.unref();
```

(Tests for `pre-compact.mjs` and `session-end.mjs` also assert the child was spawned with `detached: true` — use a sentinel env var the child writes to a temp file the test reads.)

---

### Task α.11: Artifact_kind dispatcher + legacy flat-event adapter

**Files:**
- Create: `scripts/lib/event-dispatcher.js`
- Create: `scripts/lib/legacy-adapter.js`
- Test: `tests/event-dispatcher.test.js` (extend), `tests/legacy-adapter.test.js`
- Fixture: `tests/fixtures/legacy/v01x-flat-event.jsonl` (one line representing real v0.1.x output)

- [ ] **Step 1: Write fixture (real v0.1.x flat event shape)**

```bash
mkdir -p tests/fixtures/legacy
# PR1-F W1: include BOTH legacy shapes — string `source` AND object `source`
# (real harvest.js line 642 writes object; some early v0.1.x patterns wrote string).
cat > tests/fixtures/legacy/v01x-flat-event.jsonl <<'EOF'
{"event_key":"abc123","source":"recurring-findings","run_id":"01HX","at":"2026-04-01T00:00:00Z","cards_count":3,"project_id":"p1"}
{"event_key":"def456","source":{"adapter_id":"adp_review","path":"/tmp/foo.json","content_hash":"sha256:xyz","captured_at":"2026-04-02T00:00:00Z"},"run_id":"01HY","at":"2026-04-02T00:00:00Z","cards_count":1,"project_id":"p1"}
EOF
```

- [ ] **Step 2: Write failing tests**

```js
// tests/legacy-adapter.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { wrapLegacy } = require('../scripts/lib/legacy-adapter');

test('wrapLegacy wraps v0.1.x flat event into memory-event envelope', () => {
  const flat = { event_key: 'abc123', source: 'recurring-findings', run_id: '01HX', at: '2026-04-01T00:00:00Z', cards_count: 3, project_id: 'p1' };
  const wrapped = wrapLegacy(flat);
  assert.strictEqual(wrapped.schema_version, '1.0');
  assert.strictEqual(wrapped.envelope.artifact_kind, 'memory-event');
  assert.strictEqual(wrapped.payload.event_key, 'abc123');
  assert.strictEqual(wrapped.payload.source_artifact_id.match(/^src_/) !== null, true);
  assert.strictEqual(wrapped.payload.event_kind, 'harvested');
  assert.strictEqual(wrapped.payload.cards_count, 3);
});
```

```js
// tests/event-dispatcher.test.js (extend)
const { test } = require('node:test');
const assert = require('node:assert');
const { dispatch } = require('../scripts/lib/event-dispatcher');
const fs = require('node:fs');

test('dispatcher routes envelope-shaped memory-event to memory-event validator', () => {
  const line = JSON.stringify({ schema_version: '1.0', envelope: { producer: 'deep-memory', producer_version: '0.1.3', artifact_kind: 'memory-event', run_id: '01H', generated_at: '2026-05-01T00:00:00Z', schema: { name: 'memory-event', version: '1.0' }, git: {}, provenance: { source_artifacts: [{ path: 'x' }] } }, payload: { event_key: 'a'.repeat(64), source_artifact_id: 'src_1', event_kind: 'harvested', cards_count: 1, at: '2026-05-01T00:00:00Z' } });
  const r = dispatch(line);
  assert.strictEqual(r.routed, 'memory-event');
  assert.strictEqual(r.valid, true);
});

test('dispatcher routes envelope-shaped memory-hook-event to hook validator', () => {
  // ... similar
});

test('dispatcher wraps legacy flat event via adapter (R4-H)', () => {
  const flat = fs.readFileSync('tests/fixtures/legacy/v01x-flat-event.jsonl', 'utf8').trim();
  const r = dispatch(flat);
  assert.strictEqual(r.routed, 'memory-event-legacy-wrapped');
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('dispatcher quarantines unknown shapes', () => {
  const r = dispatch('{"random":"junk"}');
  assert.strictEqual(r.routed, 'quarantine');
});
```

- [ ] **Step 3: Verify FAIL**

```bash
node --test tests/event-dispatcher.test.js tests/legacy-adapter.test.js
```

- [ ] **Step 4: Implement modules**

```js
// scripts/lib/legacy-adapter.js (PR1-F: schema-compliant wrapper)
const crypto = require('node:crypto');

function wrapLegacy(flat) {
  // PR1-F: producer_version must satisfy SemVer pattern `^\d+\.\d+\.\d+$`.
  // Real legacy events came from v0.1.0/0.1.1/0.1.2/0.1.3 — we can't recover
  // the exact version from the flat record. Default to "0.1.0" as the
  // earliest v0.1.x; later precise inference can read it from CHANGELOG.md.
  // The wrapped record is RUNTIME-ONLY (not written back to disk), so the
  // synthetic version is for ajv-validation cohesion, not user attribution.
  const producerVersion = '0.1.0';

  // PR1-F: event_key must satisfy `^[a-f0-9]{64}$`. Legacy event_key was
  // shorter (no fixed format). Normalize by sha256-hashing the original key
  // concatenated with `at` — preserves uniqueness without losing identity.
  const eventKey = /^[a-f0-9]{64}$/.test(flat.event_key)
    ? flat.event_key
    : crypto.createHash('sha256').update(`${flat.event_key}|${flat.at}`).digest('hex');

  // PR1-F: real v0.1.x `source` can be either a string (legacy fixture pattern)
  // OR an object `{adapter_id, path, content_hash, captured_at}` (per
  // scripts/harvest.js line 642). Handle both shapes.
  let sourcePath;
  if (typeof flat.source === 'string') {
    sourcePath = flat.source;
  } else if (flat.source && typeof flat.source.path === 'string') {
    sourcePath = flat.source.path;
  } else {
    sourcePath = 'legacy';
  }

  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: producerVersion,
      artifact_kind: 'memory-event',
      run_id: flat.run_id,
      generated_at: flat.at,
      schema: { name: 'memory-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: sourcePath }] }
    },
    payload: {
      event_key: eventKey,
      source_artifact_id: 'src_1',  // adapter default
      event_kind: 'harvested',       // legacy was always harvest
      cards_count: flat.cards_count || 0,
      at: flat.at
    }
  };
}
module.exports = { wrapLegacy };
```

```js
// scripts/lib/event-dispatcher.js
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');
const path = require('node:path');
const { wrapLegacy } = require('./legacy-adapter');

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validateEvent = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/memory-event.schema.json'), 'utf8')));
const validateHook = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/memory-hook-event.schema.json'), 'utf8')));

function dispatch(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return { routed: 'quarantine', reason: 'unparseable' }; }
  if (obj && obj.envelope && obj.payload) {
    if (obj.envelope.artifact_kind === 'memory-event') return { routed: 'memory-event', valid: validateEvent(obj), errors: validateEvent.errors };
    if (obj.envelope.artifact_kind === 'memory-hook-event') return { routed: 'memory-hook-event', valid: validateHook(obj), errors: validateHook.errors };
    return { routed: 'quarantine', reason: 'unknown-artifact-kind' };
  }
  // Legacy flat shape probe: R4-H corrected discriminator
  if (obj && obj.event_key && obj.at && typeof obj.cards_count !== 'undefined') {
    const wrapped = wrapLegacy(obj);
    return { routed: 'memory-event-legacy-wrapped', valid: validateEvent(wrapped), errors: validateEvent.errors };
  }
  return { routed: 'quarantine', reason: 'unknown-shape' };
}
module.exports = { dispatch };
```

- [ ] **Step 5: Verify PASS**

```bash
node --test tests/event-dispatcher.test.js tests/legacy-adapter.test.js
```

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/event-dispatcher.js scripts/lib/legacy-adapter.js tests/event-dispatcher.test.js tests/legacy-adapter.test.js tests/fixtures/legacy/v01x-flat-event.jsonl
git commit -m "feat(α.11): event_dispatcher + legacy flat-event adapter (§3.4.4 + R4-H)"
```

---

### Task α.12: Manifest updates — register Tier-1 hooks + Codex 4-hook subset

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json`
- Test: `tests/manifest-drift.test.js` (existing; verify still passes after edits)

- [ ] **Step 1: Edit `.claude-plugin/plugin.json` — add `hooks` block**

```json
"hooks": {
  "SessionStart":        [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.mjs"}]}],
  "UserPromptSubmit":    [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/user-prompt-submit.mjs"}]}],
  "PostToolUse":         [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-use.mjs"}]}],
  "PostToolUseFailure":  [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-failure.mjs"}]}],
  "PreCompact":          [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.mjs"}]}],
  "SessionEnd":          [{"matcher":"*","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-end.mjs"}]}]
}
```

- [ ] **Step 2: Edit `.codex-plugin/plugin.json` — add 4-hook subset (no matcher field; no PostToolUseFailure / SessionEnd per §3.5)**

```json
"hooks": {
  "SessionStart":    [{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/session-start.mjs"}],
  "UserPromptSubmit":[{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/user-prompt-submit.mjs"}],
  "PostToolUse":     [{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-use.mjs"}],
  "PreCompact":      [{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-compact.mjs"}]
}
```

**Note (PR1-K)**: `${CLAUDE_PLUGIN_ROOT}` is the correct env var for BOTH Claude Code AND Codex per design spec §3.5 — Codex's hook engine explicitly injects `CLAUDE_PLUGIN_ROOT` into hook subprocesses (referenced in [`codex-rs/hooks/src/engine/discovery.rs`](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs)). This is by design for Codex/Claude-Code cross-runtime compatibility — the same hook scripts work on both hosts without duplication. agentmemory uses the same pattern (verified during spec research). The Plan-Round-1 Codex-adversarial concern (HIGH-4) about `CLAUDE_PLUGIN_ROOT` not being set on Codex is incorrect — Codex sets it. Documenting the cross-runtime contract here so future contributors don't second-guess.

- [ ] **Step 3: Run manifest-drift gate**

```bash
node --test tests/manifest-drift.test.js 2>&1
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "feat(α.12): register Tier-1 hooks in both manifests (§3.5)"
```

---

### Task α.13: G-α-latency macrobenchmark fixture + gate

**Files:**
- Create: `tests/fixtures/hooks/g-alpha-macro.jsonl` (30 events, realistic sizes per R2-N)
- Create: `tests/g-alpha-latency.test.js`

- [ ] **Step 1: Record fixture (or hand-build approximation)**

```js
// scripts/build-g-alpha-fixture.js (one-off helper, not committed in src; output is the fixture)
const fs = require('node:fs');
const out = [];
for (let i = 0; i < 30; i++) {
  const outputSize = i % 5 === 0 ? 8192 : 2048;
  out.push(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: `src/x${i}.ts`, old_string: 'a'.repeat(100), new_string: 'b'.repeat(100) }, tool_output: 'x'.repeat(outputSize), session_id: 'g-alpha-bench' }));
}
fs.writeFileSync('tests/fixtures/hooks/g-alpha-macro.jsonl', out.join('\n') + '\n');
```

Run once: `node scripts/build-g-alpha-fixture.js && rm scripts/build-g-alpha-fixture.js`.

- [ ] **Step 2: Write the gate test**

```js
// tests/g-alpha-latency.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('G-α-latency: 30 PostToolUse fires p95 ≤ 400ms (R2-N)', { skip: !process.env.LATENCY }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-galpha-'));
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'), 'capture:\n  enabled: true\n');
  const fixture = fs.readFileSync('tests/fixtures/hooks/g-alpha-macro.jsonl', 'utf8').trim().split('\n');
  const durations = [];
  for (const line of fixture) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], { input: line, env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot }, encoding: 'utf8' });
    const t1 = process.hrtime.bigint();
    assert.strictEqual(r.status, 0);
    durations.push(Number(t1 - t0) / 1_000_000);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)];
  console.log(`G-α p95 = ${p95.toFixed(1)} ms (target ≤ 400)`);
  assert.ok(p95 <= 400, `G-α p95 = ${p95.toFixed(1)} ms > 400 ms — redesign hook flow (async buffer + flush)`);
});
```

- [ ] **Step 3: Run gate (locally + CI)**

```bash
LATENCY=1 node --test tests/g-alpha-latency.test.js
```

Expected: PASS. If FAIL, redesign hook flow (move Pass 0 redact + atomic append to async buffer pattern per §3.2.2 fallback).

- [ ] **Step 4: Add to CI matrix**

Edit `.github/workflows/ci.yml` to include a `LATENCY=1` job at the end of Phase α.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/hooks/g-alpha-macro.jsonl tests/g-alpha-latency.test.js .github/workflows/ci.yml
git commit -m "test(α.13): G-α-latency gate + macrobenchmark fixture (R2-N)"
```

**Phase 0.3.0-α exit gate**: G-α-latency PASS + all α tests green + manifest-drift CI green. Run `deep-review-loop` on Phase α work. Address findings, then proceed to Phase β.

---

# Phase 0.3.0-β — mapHookSession + Lazy Distill + Cursor + Batch Refine + Lock Split

**Gate**: G-β-latency (30 fires p95 ≤ 500 ms with concurrent brief) + distill pipeline tests green.

### Task β.1: Byte-offset cursor module

**Files:**
- Create: `scripts/lib/cursor.js`
- Test: `tests/cursor.test.js`

- [ ] **Step 1: Write failing tests** (read/write, rollover, token-cap deferred reachability R4-B)

```js
// tests/cursor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCursor, writeCursor, advanceTo } = require('../scripts/lib/cursor');

test('cursor: write/read roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
  writeCursor(dir, 'p1', '2026-05.jsonl', 184320);
  const c = readCursor(dir, 'p1');
  assert.deepStrictEqual(c, { file: '2026-05.jsonl', offset: 184320 });
});

test('cursor: token-cap deferred line stays before cursor (R4-B)', () => {
  // simulate: 3 lines processed, 4th token-cap-deferred
  // advanceTo should move cursor to offset of line 4 START (i.e. past line 3 only)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  const lines = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n', '{"d":4}\n'];
  fs.writeFileSync(path.join(dir, 'events/2026-05.jsonl'), lines.join(''));
  const lastProcessedEndOffset = (lines[0] + lines[1] + lines[2]).length;
  writeCursor(dir, 'p1', '2026-05.jsonl', lastProcessedEndOffset);
  const c = readCursor(dir, 'p1');
  assert.strictEqual(c.offset, lastProcessedEndOffset);  // Line 4 ('d') starts here, not skipped
});
```

- [ ] **Step 2: Verify FAIL**

```bash
node --test tests/cursor.test.js
```

- [ ] **Step 3: Implement `scripts/lib/cursor.js`**

```js
// scripts/lib/cursor.js
const fs = require('node:fs');
const path = require('node:path');

function cursorPath(root, projectId) {
  return path.join(root, '.last-distill-cursor', projectId);
}

function readCursor(root, projectId) {
  try {
    const text = fs.readFileSync(cursorPath(root, projectId), 'utf8').trim();
    const [file, offset] = text.split(':');
    return { file, offset: parseInt(offset, 10) };
  } catch {
    return null;
  }
}

function writeCursor(root, projectId, file, offset) {
  const p = cursorPath(root, projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, `${file}:${offset}\n`);
  fs.renameSync(tmp, p);
}

function advanceTo(root, projectId, file, offset) {
  const existing = readCursor(root, projectId);
  if (existing && existing.file === file && existing.offset >= offset) return;  // monotonic
  writeCursor(root, projectId, file, offset);
}

module.exports = { readCursor, writeCursor, advanceTo };
```

- [ ] **Step 4: Verify PASS**

```bash
node --test tests/cursor.test.js
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/cursor.js tests/cursor.test.js
git commit -m "feat(β.1): byte-offset cursor module (§3.4.3 + R3-A + R4-B)"
```

---

### Tasks β.2 – β.10 (condensed format — TDD pattern same as above)

**Task β.2 — Pre-LLM dedupe gate** (`scripts/lib/llm-bridge.js` extend; test `tests/refine-batch.test.js`): before `refineBatch()`, scan `cards/<type>/<proj>/` for prospective `dedupe_key` matches, remove from batch.

**Task β.3 — `refineBatch()` in llm-bridge** (modify `scripts/lib/llm-bridge.js`): bundle ≤ `config.distill.batch_size` (default 5) drafts per LLM call; response `{drafts:[...]}` ajv-validated; per-draft fallback to candidate on violation.

**Task β.4 — `mapHookSession` + 5 detectors** (new `scripts/lib/distill-hook-session.js`; test `tests/distill-hook-session.test.js`, 15 tests + 5 session fixtures `tests/fixtures/sessions/*.jsonl`): patternDetector / failureDetector / decisionDetector / styleDetector / sessionSummary per §4.2.

**Task β.5 — Lazy distill + Stage 0a integration** (modify `scripts/brief.js` + `scripts/harvest.js`; test `tests/distill-trigger-lazy.test.js`): in `runBrief`, query `events.jsonl` past cursor BEFORE retrieval; run distill pipeline; advance cursor; THEN retrieve. **W5 fix**: After Stage 6 commit, write `<repo>/.deep-memory/latest-distill.json` with `{processed_events, drafts_emitted, cards_committed, warnings, started_at, finished_at}` (atomic temp+rename). `hooks-stats.json` (per-hook counter telemetry) is deferred to v0.3.x — recorded in `docs/handoff-v0.3.0-postrelease.md` (Task final.4) as a §15 plan-phase open question.

**Task β.6 — Stage 1c cross-project filter** (R4-C; modify `scripts/lib/distill-hook-session.js` or `scripts/harvest.js` per where Stage 1c lives; test `tests/cross-project-filter.test.js`): filter pending events by `envelope.project_id == current_project_id` BEFORE grouping by session_id.

**Task β.7 — Stage 6 cursor advance "processed" semantics** (R3-F + R4-B; modify `scripts/harvest.js` distill pipeline): advance cursor to byte offset AFTER last contiguous committed-or-zero-draft line; deferred lines stay before cursor.

**Task β.8 — Lock granularity split** (modify `scripts/lib/lock.js`; test `tests/lock-split.test.js`): introduce `acquireShortLock` / `releaseLock` for critical sections (cursor scan + commit only). Existing hook append uses short lock.

**Task β.9 — Eager distill fire-and-forget invariants** (extend `scripts/hooks/pre-compact.mjs` + `session-end.mjs`; test `tests/fire-and-forget.test.js`): `detach + unref`, heartbeat to `.leases/<proj>.lease`, back-to-back coalesce (skip if last_heartbeat_at < 30s).

**Task β.10 — G-β-latency gate** (modify `tests/g-beta-latency.test.js`): macrobenchmark = G-α + concurrent `/deep-memory-brief` call mid-stream; p95 ≤ 500 ms.

For each: write test → verify FAIL → implement → verify PASS → commit `feat(β.N): <description>`.

**Phase 0.3.0-β exit gate**: G-β-latency PASS + all β tests green + `deep-review-loop` on Phase β work passes.

---

# Phase 0.3.0-γ — Vector Index + RRF Fusion + Rerank Integration

**Gate**: hybrid retrieval works in both `match` and `mismatch` model states; FTS5-only fallback green when @xenova absent.

### Task γ.1: Pre-γ — C-R1 widening (composite `(memory_id, project_id)` FTS5 + vector key)

**Skip this task if v0.2.0 backported the widening.** Otherwise:
- Modify `scripts/lib/fts-index.js` — change `memoryIdFor()` signature to include `project_id`; FTS5 primary key becomes composite `(memory_id, project_id)`.
- Add migration test: existing v0.2.x rows with old single-key get rebuilt with composite key.
- Commit `feat(γ.1): C-R1 widening — composite (memory_id, project_id) key (handoff-phase-4-6.md)`.

### Task γ.2: Vector index schema + writer (`scripts/lib/vector-index.js`)

DDL per §5.2 (`card_vectors` table, `privacy_level` NOT `privacy_scope`, composite key per Task γ.1). Brute-force cosine search. Tests: 8 (embed→BLOB→cosine→rank).

### Task γ.3: Embedding module — `@xenova/transformers` lazy load + R3-G mismatch handling + R4-I try-catch (W7 — widened catch)

**W7 fix**: try-catch in `loadModel()` must catch ALL load-time errors, not just `MODULE_NOT_FOUND`. Real failures from `@xenova/transformers` include `ERR_PACKAGE_PATH_NOT_EXPORTED`, native-module init errors (`onnxruntime-node` missing peer), and runtime fetch failures. Use a permissive catch:

```js
async function loadModel() {
  if (modelCache) return modelCache;
  try {
    const { pipeline } = await import('@xenova/transformers');
    modelCache = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return modelCache;
  } catch (e) {
    // W7: any error during optional-dep load → graceful FTS5-only fallback
    console.warn(`[deep-memory] embedding model unavailable: ${e.message}; falling back to FTS5-only retrieval`);
    return null;
  }
}
function loadedModelVersion() {
  try {
    const pkg = require('@xenova/transformers/package.json');
    return pkg.version + '@Xenova/all-MiniLM-L6-v2';
  } catch { return null; }
}
```

Test `tests/embed-model-broken-install.test.js` (new — beyond the 4-pass test): fixture with `@xenova/transformers/package.json` present but `index.js` stub that throws `new Error('onnxruntime-node failed to load')` → assert `loadModel()` returns `null` and warning is emitted.

(`scripts/lib/embed-model.js`; test `tests/embed-model-mismatch.test.js`)

```js
let modelCache = null;
async function loadModel() {
  if (modelCache) return modelCache;
  try {
    const { pipeline } = await import('@xenova/transformers');
    modelCache = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return modelCache;
  } catch (e) {
    // PR2-E + R4-I + W7: widened catch — any error during optional-dep
    // load (MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED,
    // native-module init failures, runtime fetch errors) → graceful FTS5-only.
    console.warn(`[deep-memory] embedding model unavailable: ${e.message}; falling back to FTS5-only`);
    return null;
  }
}

function loadedModelVersion() {
  try {
    const pkg = require('@xenova/transformers/package.json');
    return pkg.version + '@Xenova/all-MiniLM-L6-v2';
  } catch (e) {
    return null;  // R4-I: graceful FTS5-only
  }
}
```

Test: 4-pass check (absent, present-match, present-mismatch, present-write-version).

### Task γ.4: RRF fusion (`scripts/lib/rrf-fusion.js`)

```js
// PR2-F: After γ.1 widens retrieval identity to composite (memory_id, project_id),
// the fusion map MUST key on the composite identity. Otherwise two visible cards
// (one local in current project, one global from another project sharing
// dedupe_key) collapse into a single fused row and the reranker loses one.
function compositeKey(card) { return `${card.memory_id}|${card.project_id}`; }

function rrfFuse(streamA, streamB, k = 60) {
  const scores = new Map();     // composite key → score
  const cardByKey = new Map();  // composite key → card (to preserve project_id in output)
  for (let i = 0; i < streamA.length; i++) {
    const key = compositeKey(streamA[i]);
    scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    cardByKey.set(key, streamA[i]);
  }
  for (let i = 0; i < streamB.length; i++) {
    const key = compositeKey(streamB[i]);
    scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
    cardByKey.set(key, streamB[i]);
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({
      memory_id: cardByKey.get(key).memory_id,
      project_id: cardByKey.get(key).project_id,
      score
    }));
}
module.exports = { rrfFuse, compositeKey };
```

Tests: 6 scenarios.

### Task γ.5: Integrate Vector + RRF into `scripts/retrieve.js`

- 2-stream parallel candidate gen.
- RRF fusion.
- Existing 6-stage rerank consumes fused.
- Privacy filter `WHERE privacy_level = 'global' OR project_id = <current>` per §5.1.

### Task γ.6: Stage 8 session_id diversification (modify `scripts/lib/score.js`)

Add max 3 per `session_id` cap; v0.1.x cards without session_id bypass naturally.

### Task γ.7: Graceful degradation matrix wiring (extend `scripts/retrieve.js`)

Implement §5.4 matrix — surface warnings via `cards.warnings[]` + `latest-brief.warnings[]` + MCP response.

Each task: write test → FAIL → implement → PASS → commit `feat(γ.N): ...`.

**Phase 0.3.0-γ exit gate**: hybrid retrieval tests pass under match + mismatch + @xenova-absent scenarios. `deep-review-loop` on Phase γ.

---

# Phase 0.3.0-δ — MCP Server + 10 Tools + Slash Skills + Privacy Gates

**Gate**: MCP lifecycle test passes + all 10 tool schema-validation tests pass + Gate 1/2/3 enforcement tests pass + cross-project filter test passes.

### Task δ.1: MCP server entry (`scripts/mcp-server.mjs`) + `.mcp.json` for Codex (R4-G)

**Files:**
- Create: `scripts/mcp-server.mjs`
- Create: `.mcp.json`
- Modify: `.codex-plugin/plugin.json` (add `"mcpServers": "./.mcp.json"`)
- Modify: `.claude-plugin/plugin.json` (add inline `mcpServers` block)
- Test: `tests/mcp-server-lifecycle.test.js`

- [ ] **Step 1: Write failing lifecycle test** (spawn → multi-call → EOF → lease cleanup)

```js
// tests/mcp-server-lifecycle.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

test('MCP server: spawn → list tools → EOF → exit 0', async () => {
  const child = spawn('node', ['scripts/mcp-server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await new Promise(r => setTimeout(r, 500));
  child.stdin.end();
  const exit = await new Promise(r => child.on('exit', r));
  assert.strictEqual(exit, 0);
});
```

- [ ] **Step 2: Verify FAIL.**

- [ ] **Step 3: Implement minimal `scripts/mcp-server.mjs`** (just enough to pass lifecycle test; tools come in δ.3 onward)

```js
// scripts/mcp-server.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'deep-memory', version: '0.3.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));  // populated in δ.3+
server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `not-yet-impl: ${req.params.name}` }] }));

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Create `.mcp.json` (Codex path form)**

```json
{ "mcpServers": { "deep-memory": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"], "env": { "DEEP_MEMORY_ROOT": "${DEEP_MEMORY_ROOT:-}" } } } }
```

- [ ] **Step 5: Update manifests**

`.claude-plugin/plugin.json`:
```json
"mcpServers": { "deep-memory": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"], "env": { "DEEP_MEMORY_ROOT": "${DEEP_MEMORY_ROOT:-}" } } }
```

`.codex-plugin/plugin.json`:
```json
"mcpServers": "./.mcp.json"
```

- [ ] **Step 6: Add `@modelcontextprotocol/sdk` to package.json**

```bash
npm install --save '@modelcontextprotocol/sdk@^1'
```

- [ ] **Step 7: Verify PASS + manifest-drift green**

```bash
node --test tests/mcp-server-lifecycle.test.js
node --test tests/manifest-drift.test.js
```

- [ ] **Step 8: Commit**

```bash
git add scripts/mcp-server.mjs .mcp.json .claude-plugin/plugin.json .codex-plugin/plugin.json package.json package-lock.json tests/mcp-server-lifecycle.test.js
git commit -m "feat(δ.1): MCP server entry + Codex .mcp.json wiring (R4-G)"
```

### Task δ.2: privacy-gate module (`scripts/lib/privacy-gate.js`)

Implements §6.3.1 Gates 1/2/3 — schema-level (inputSchema `const`/`enum`) AND runtime guards. Returns structured error `{error, message, remediation, audit_entry_id}`. Tests: `tests/privacy-gates.test.js` (R4-F items).

### Tasks δ.3 – δ.12: 10 MCP tools (one task each)

For each tool, register via `server.setRequestHandler(CallToolRequestSchema, ...)` and add to `ListToolsRequestSchema` response. Each task:
- Write `tests/mcp-tools/<name>.test.js` (input schema validation + happy + error paths)
- Implement tool in `scripts/mcp-server.mjs` (delegate to existing lib via dynamic `import()`)
- Verify PASS
- Commit `feat(δ.N): MCP tool <name>`

Per-tool details:
- **δ.3 `deep_memory_brief`** — `inputSchema: project_scope const 'current'`; delegate to `scripts/brief.js#runBrief`.
- **δ.4 `deep_memory_smart_search`** — `inputSchema` omits `project_scope`; delegate to `scripts/retrieve.js#runRetrieve`.
- **δ.5 `deep_memory_recall`** — same as smart_search with `vector: false`.
- **δ.6 `deep_memory_save`** — `privacy: 'local'` only (Gate 1 implicit); delegate to `scripts/save.js`.
- **δ.7 `deep_memory_harvest`** — `source` enum `siblings | all` (no `hooks` per R-014); delegate to `scripts/harvest.js`.
- **δ.8 `deep_memory_audit`** — `mode: const 'check'` for autonomous; non-check returns `slash_only_in_v030`; delegate to `scripts/audit.js`.
- **δ.9 `deep_memory_forget`** — registered placeholder; always returns `error: slash_only_in_v030` per R3-B option (a).
- **δ.10 `deep_memory_sessions`** — events.jsonl scan; returns `{session_id, host, started_at, ended_at?, event_count, top_tool_names[]}`.
- **δ.11 `deep_memory_profile`** — reads `.deep-memory/project-profile.json`.
- **δ.12 `deep_memory_export`** — `filter` excludes `project_id` (current-only); delegate to `scripts/export.js`.

### Task δ.13: 5 MCP resources

Register `deep-memory://status`, `deep-memory://project/{id}/profile` (current-only), `deep-memory://cards/latest`, `deep-memory://config`, `deep-memory://audit/last`. Test: each returns expected shape.

### Task δ.14: 2 MCP prompts

Register `deep_memory_recall_context`, `deep_memory_session_handoff`. Test: each returns prompt template.

### Tasks δ.15 – δ.18: 4 new slash skills

For each of `/deep-memory-remember`, `/deep-memory-recall`, `/deep-memory-forget`, `/deep-memory-export`:
- Create `skills/<name>/SKILL.md` with `user-invocable: true` frontmatter, description, steps.
- The slash skill calls the same lib functions as the MCP tool counterpart.
- `/deep-memory-export` and `/deep-memory-forget` write audit-log entries per §6.3.1 envelope.

### Task δ.19: Modify `skills/deep-memory-audit/SKILL.md` — slash supports all modes

Add `--unlock`, `--rebuild-index`, `--rebuild-vectors`, `--promote <id>` flag handling. MCP autonomous path (via `scripts/mcp-server.mjs`) restricts to `mode='check'` per Task δ.8.

### Task δ.20: Cross-project filter tests + privacy gates acceptance (R4-F) + R4-A/R4-E/R4-K explicit assertions (PR1-I fix)

Per Plan-Round-1 PR1-I: each spec §12 R4-F acceptance item must have a concrete test binding. Distribute as:

- **R4-A** (`deep_memory_forget` autonomous MCP returns slash-only error) → `tests/mcp-tools/forget.test.js` (new file): assert `tools/list` lists `deep_memory_forget` but `tools/call deep_memory_forget {memory_id, reason}` returns `error: slash_only_in_v030` + audit-log gate-violation entry.
- **R4-B** (token-cap deferred line reachable) → `tests/distill-trigger-lazy.test.js` (new, not `tests/cursor.test.js` which is unit-level): fixture with 10 hook events + `distill.max_llm_tokens_per_run` set low → first brief processes ~5 events + advances cursor only past committed lines; second brief picks up remaining deferred lines; no event lost.
- **R4-C** (cross-project filter) → `tests/cross-project-filter.test.js` per existing task β.6.
- **R4-D** (capture.enabled gate) → `tests/capture-enabled-gate.test.js` per existing task α.4.
- **R4-E** (audit-log envelope conformance from all writers) → NEW `tests/audit-log-writer-conformance.test.js` (**CREATED IN δ.20 — phase ordering fix per Plan-Round-2 W1 / Codex adv MED**; ε.2 audits the writer list and re-runs this test as part of ε exit gate, but the file exists by end of δ. All 7 writers (save/forget/audit/export/init.js/hook/MCP-gate-violation) exist by end of δ — file is physically executable at δ-end): spawn each of the 7 writers in a temp DEEP_MEMORY_ROOT, capture audit-log/ output, ajv-validate every line against `schemas/audit-log-entry.schema.json`.
- **R4-F** (privacy gates) → `tests/privacy-gates.test.js`: 3 gate-violation scenarios per §6.3.1.
- **R4-K** (dual emission on slash mutations) → asserted inside `tests/audit-log-writer-conformance.test.js`: a single `/deep-memory-forget` invocation writes exactly 2 audit-log entries with shared `at` (within 1ms tolerance) — first `kind: 'mutation-consent'`, second `kind: 'forget'`.

Phase 0.3.0-δ exit gate now also requires: `tests/mcp-tools/forget.test.js` PASS + `tests/audit-log-writer-conformance.test.js` PASS.

**Phase 0.3.0-δ exit gate**: MCP lifecycle + 10 tool tests + 5 resource tests + 2 prompt tests + Gate 1/2/3 tests + cross-project filter test + audit-log envelope test all green. `deep-review-loop` on Phase δ.

---

# Phase 0.3.0-ε — Migration + audit-log envelope + storage version + capture default + backstop tests

**Gate**: migration roundtrip + downgrade safe + back-to-back hook fire test.

### Task ε.1: audit-log envelope writer (`scripts/lib/audit-log.js`)

Writes envelope-conformant entries per §6.3.1. Used by all writers (hook, slash, MCP, init). Test: 10 kinds round-trip.

### Task ε.2: Validate all writers conform to envelope (R3-J + R4-E)

Audit all sites that append to `audit-log/`:
- `scripts/save.js` writes `kind: 'save'`.
- `scripts/forget.js` writes `kind: 'mutation-consent'` then `kind: 'forget'` (dual emission per R4-K).
- `scripts/audit.js` writes `kind: 'mutation-consent'` then kind-specific (unlock/rebuild/promote).
- `scripts/export.js` writes `kind: 'cross-project-export'`.
- `scripts/init.js` migration writes `kind: 'capture-toggle'` with `by: 'init-migration'`.
- `scripts/hooks/*.mjs` write `kind: 'capture-toggle'` only when toggling, otherwise nothing.
- MCP gate violations write `kind: 'gate-violation'`.

**Concrete test file** (PR1-I fix, R4-E binding; **moved to δ.20 per Plan-Round-2 W1 phase-ordering fix** — see δ.20 above): `tests/audit-log-writer-conformance.test.js` is **created by δ.20**, and ε.2's role is to consolidate the writer audit list and re-run the test as part of ε exit gate (verifies no new writer was added without joining the envelope). Test body: spawn each of the 7 writers in a temp `DEEP_MEMORY_ROOT`, drive each through one realistic action (save a card, forget a card, run audit unlock, export current project, run init migration, fire one hook, trigger an MCP gate-violation), then `cat audit-log/YYYY-MM.jsonl` and ajv-validate every line against `schemas/audit-log-entry.schema.json` (compiled with `require('ajv/dist/2020').default` per PR1-A). Also assert R4-K dual emission: a `/deep-memory-forget` invocation produces exactly 2 lines (`kind: 'mutation-consent'` then `kind: 'forget'`) with `at` values within 1ms.

### Task ε.3: `scripts/init.js` — multi-marker detection (R3-D + R4-J) + capture-default policy (R4-D + §3.6)

- Multi-marker scan: presence of `.storage-version` → use; else scan up to 50 cards' `producer_version`, use lex-max.
- Capture default: interactive entry prompts; non-interactive defaults to `false` with `latest-distill.warnings[]` entry + status resource hint.
- Test: 4 scenarios (fresh interactive, fresh non-interactive, v0.2.x upgrade interactive, v0.2.x upgrade non-interactive).

### Task ε.4: Migration — byte-offset cursor initialization (R3-A) + storage-version bump

- On v0.2.x→v0.3.0 first run: write `.last-distill-cursor/<proj>` as `<current-month>.jsonl:<file_size>` (R3-A fix); NOT ISO timestamp.
- `mkdir -p` audit-log + .last-distill-cursor + indexes (vector.sqlite).
- Build vector index (if @xenova present) or skip with warning.
- Merge new config keys.
- Write `.storage-version` = "0.3".
- Test: mock v0.2.x storage → init → assert cursor format + .storage-version + warnings.

### Task ε.5: Downgrade safety smoke test (`tests/downgrade-safe.test.js`)

- Initialize v0.3.0 store, write some cards.
- Verify v0.1.x reader (existing `scripts/lib/envelope.js` validate path) reads cards without crash.
- Verify v0.3.0-only files (`vector.sqlite`, `audit-log/`, `.embed-model-version`) are ignored.

### Task ε.6: Back-to-back hook fire test (§3.2.1)

- Spawn 2 hook scripts (PreCompact then SessionEnd) within 1s.
- Assert exactly 1 distill child runs (second coalesces via `last_heartbeat_at < 30s` check).
- Assert `.lock` + `.leases/` cleaned within 60s.

**Phase 0.3.0-ε exit gate**: all ε tests green + `deep-review-loop` on ε.

---

# Phase 0.3.0-final — Docs + Cross-repo + Release

**Gate**: cross-repo manifest-drift green.

### Task final.1: CHANGELOG.md + CHANGELOG.ko.md — v0.3.0 entry

Include Breaking section: storage-version bump, mutation slash-only, schema additions. Reference design spec + plan.

### Task final.2: README.md + README.ko.md — architecture diagram + MCP wiring guide + migration note

3-layer architecture diagram (copy from spec §2). MCP wiring (Claude Code inline / Codex .mcp.json path). Migration: v0.2.x→v0.3.0 automatic; v0.1.3→v0.3.0 two-step required.

### Task final.3: Cross-repo deep-suite manifest update

Use `DEEP_SUITE_ROOT` env var per R-021. Update:
- `marketplace.json` × 2 (sha + description)
- `suite-extensions.json` (artifacts: add `hooks`, `mcp-server`; data_flow updated)

### Task final.4: 3-manifest version bump → 0.3.0 + manifest-drift CI verify + create `docs/handoff-v0.3.0-postrelease.md`

- `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` all → `0.3.0`.
- `node --test tests/manifest-drift.test.js` green.
- Create `docs/handoff-v0.3.0-postrelease.md` documenting §15 plan-phase open questions (Q1-Q7) as v0.3.x backlog.

**Phase 0.3.0-final exit gate**: cross-repo CI green, release tagged.

---

## Self-Review (writing-plans checklist)

**Spec coverage**: Each spec section mapped to tasks:
- §1 D1-D8: implicit in all phase choices.
- §2 architecture: 3-layer reflected in Phase α/β/γ/δ task grouping.
- §3 capture: Tasks α.1, α.3, α.4, α.5–α.10, α.11, α.12, α.13.
- §4 distill: Tasks β.1–β.10.
- §5 retrieval: Tasks γ.1–γ.7.
- §6 MCP: Tasks δ.1–δ.20.
- §7 storage: implicit (no separate task; mkdir paths in init + migration).
- §8 migration: Tasks ε.3, ε.4, ε.5.
- §9 testing: distributed across all tasks (each has TDD test).
- §10 out-of-scope: not implemented (correct).
- §11 phase plan: matches plan's 6 phases.
- §12 acceptance: covered by tests across phases; new R4-F items in Task δ.20 + ε.6.
- §13 cross-repo: Task final.3.
- §14 references: linked in CHANGELOG (Task final.1).
- §15 open questions: deferred to `docs/handoff-v0.3.0-postrelease.md` (Task final.4).

**Placeholder scan**: No "TBD"/"TODO"/"implement later" in task bodies. Each task has files / steps / code / commit. Tasks β.2-β.10 + γ.1-γ.7 + δ.13-δ.19 + ε.1-ε.6 use condensed format (pattern reference + key code/commands) — explicit pattern: "write test → verify FAIL → implement → verify PASS → commit `feat(<phase>.<n>): ...`" applies uniformly per writing-plans skill's bite-sized-task principle. Condensed only because TDD pattern is identical; engineer reads the explicit α.1/α.2/α.11 templates and applies them.

**Type consistency**: cursor format (`<file>:<offset>`) used in cursor.js + harvest.js + init.js migration consistently. `memory-hook-event` schema fields match dispatcher + common.mjs normalizer. Audit-log envelope shape uniform across all writers (per task ε.2 audit). Privacy gate error names (`slash_only_in_v030` / `scope_not_permitted`) match between privacy-gate.js + audit.js + forget.js + export.js.

---

**Plan complete. Saved to `docs/superpowers/plans/2026-05-22-deep-memory-v0.3.0.md`.**
