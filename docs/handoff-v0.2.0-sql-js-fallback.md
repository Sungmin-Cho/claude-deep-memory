# deep-memory v0.2.0 — sql.js WASM fallback handoff

> **Audience**: the contributor who picks up `deep-memory` work after v0.1.3.
> Companion to `docs/handoff-phase-4-6.md` (Phase 4 / 5 / 6 forward roadmap)
> and `docs/handoff-v0.1.x-immediate.md` (v0.1.x patch work, already shipped).
> This file is the **scope of record** for the v0.2.0 native-binding decoupling
> track — i.e. replacing `better-sqlite3` as the FTS5 backend with a portable
> WASM-based alternative (`sql.js`).

---

## 0. Why v0.2.0

v0.1.2 added graceful runtime degradation when `better-sqlite3` fails to load,
and v0.1.3 moved `better-sqlite3` to `optionalDependencies` so `npm install`
itself succeeds even when the native build fails. Those two together unblock
the first-use scenario, but they leave the indexed-retrieval path **non-functional**
on environments where the native binding can't load (Node v26+ marketplace
plugin cache, Windows without VC++ build tools, ARM Linux containers without
prebuilt support, etc.).

The actual fix is a portable FTS5 backend that doesn't depend on a native
toolchain. `sql.js` (SQLite compiled to WebAssembly via Emscripten) is the
mature choice — it ships as a pure-JS / WASM bundle, works in any Node 16+
runtime, supports FTS5 out of the box, and the JavaScript API is close
enough to `better-sqlite3` that the existing `scripts/lib/fts-index.js` shape
can be preserved.

v0.2.0 ships when sql.js is the default backend and `better-sqlite3` is
either removed entirely OR demoted to a "high-performance optional" path
selected at runtime by environment probe.

> Performance note: better-sqlite3 is ~3-5× faster than sql.js on insert
> heavy workloads. For deep-memory's use case (write-once at harvest, many
> reads at brief), the gap is acceptable — harvest writes ≤ low hundreds
> of cards per session, retrieval reads ≤ N×3 rows (N≈8). The native
> binding can stay as an opt-in performance escape hatch (env flag
> `DEEP_MEMORY_USE_NATIVE_SQLITE=1` or auto-detect on success).

---

## 1. Current state (after v0.1.3)

- `scripts/lib/fts-index.js` lines 26–36: hard-fail at `require('better-sqlite3')`
  with a descriptive error if the load throws. Caller (`harvest.js` / `retrieve.js`)
  catches at module scope and routes to graceful degradation.
- `scripts/harvest.js` lines 24–58: defines `FTS_DEGRADED_WARNING` + the catch.
  When `fts === null`, `persistWithLockAndLease` skips the FTS5 upsert and the
  return value carries a non-enumerable `cards.warnings` array. CLI mirrors
  to `latest-harvest.json`. v0.1.3 routes the error message through `redactString`.
- `scripts/retrieve.js` lines 11–37: symmetric `_fts` / `_ftsLoadError` guard.
  `runRetrieve` returns `{ memories: [], warnings: [...] }` when `_fts === null`.
- `package.json`: `better-sqlite3: "^12.0.0"` in `optionalDependencies`,
  `sql.js: "^1.10.0"` already preinstalled (was prep for this v0.2.0 track,
  never wired).
- `tests/harvest-fts-silent-disable.test.js` + `tests/retrieve-fts-degraded.test.js`:
  spawn-fork tests that simulate fts-index require failure and verify the
  graceful + redacted warning path.

---

## 2. v0.2.0 scope

### 2.1 In-scope

1. **`scripts/lib/fts-index-sqljs.js`** — sql.js implementation of the same
   API surface as `fts-index.js`: `openIndex(path)`, `upsertCard(idx, card, { projectId })`,
   `search(idx, query, { topN, projectId })`, `closeIndex(idx)`.
   - Persistence: sql.js loads the DB file into memory, mutations go to RAM,
     `closeIndex` calls `db.export()` → `fs.writeFileSync` (atomic tmp+rename).
   - The harvest critical section needs to hold the global lock long enough
     to cover the in-memory mutation + the disk export. spec §7.3 already
     requires this.
2. **Backend dispatcher in `scripts/lib/fts-index.js`** — replaces the
   current "hard require('better-sqlite3')" with a 3-tier probe:
   ```
   1. if DEEP_MEMORY_FTS_BACKEND env is set → use that (better-sqlite3 | sqljs)
   2. else try better-sqlite3 (in optionalDependencies); if loadable, use it
   3. else fall back to sql.js (in dependencies, always present)
   ```
   The probe runs once at module load. `driver` field on the index object
   indicates which backend is active (already there as `idx.driver === 'better-sqlite3'`
   for transaction begin/commit gating — `sqljs` variant has different
   transaction semantics; keep the gate).
3. **`sql.js` in `dependencies`** — pin to a known-good version (currently
   ^1.10.0). Bundle size: ~1MB WASM. Document the trade in README.
4. **Graceful degradation removal** — once sql.js is the always-available
   fallback, the v0.1.2 `fts === null` paths in harvest.js / retrieve.js can
   be deleted. cards.warnings + FTS_DEGRADED_WARNING constant become obsolete.
   tests/harvest-fts-silent-disable.test.js + tests/retrieve-fts-degraded.test.js
   convert into "backend probe selects sqljs when better-sqlite3 absent" tests.
5. **CHANGELOG + README + Troubleshooting** — flip the Troubleshooting
   section from "use Node 22 LTS workaround" to "sql.js is the default
   backend; better-sqlite3 is opt-in for performance".

### 2.2 Out-of-scope (deferred)

- Migrate the existing FTS5 schema if it differs from sql.js's FTS5
  defaults. (Spot-check: sql.js compiles SQLite 3.41+ with FTS5 enabled
  via `-DSQLITE_ENABLE_FTS5=1`. Same dialect as native better-sqlite3.)
- Add a sql.js performance benchmark + numbers in README. Useful for
  documenting the "opt-in better-sqlite3" path but not blocking.
- Replace the runtime-only backend probe with a build-time decision (e.g.
  webpack/esbuild). Out of scope until deep-memory adds a build step.

### 2.3 What stays the same

- spec §7.1 mapper rules (Step A) — independent of backend.
- spec §7.3 lock/lease/event-key invariants — same critical section, just
  different DB driver inside it.
- spec §8 retrieval pipeline — Stage 0 SQL `WHERE` clause logic identical.
  bm25() function — both backends support it (sql.js inherits SQLite FTS5).
- All envelope / redaction / privacy invariants — unchanged.
- `cards/`, `events/`, `indexes/lexical.sqlite` on-disk layout — unchanged.
  An indexes file written by sql.js is binary-compatible with one written
  by better-sqlite3 (same SQLite file format).

---

## 3. Acceptance criteria

- [ ] `node -e "require('better-sqlite3')"` failure mode no longer causes
      degraded harvest. Instead, harvest writes cards/events AND populates
      the FTS5 index via sql.js, and `/deep-memory-brief` returns non-empty
      results just like the native path.
- [ ] `DEEP_MEMORY_FTS_BACKEND=sqljs npm test` PASS — runs the whole suite
      against the sql.js backend. (Add to CI matrix.)
- [ ] `DEEP_MEMORY_FTS_BACKEND=better-sqlite3 npm test` PASS — opt-in
      native path still works.
- [ ] Default `npm test` (no env) PASS — backend probe selects best
      available; tests that previously asserted "degraded → empty memories"
      now assert "sqljs selected, retrieval works".
- [ ] Existing `lexical.sqlite` files from v0.1.x users are read OK by
      sql.js without migration. (One-way compatibility check; if not,
      add a one-time migration in `init.js`.)
- [ ] README + CHANGELOG describe the new default backend; Troubleshooting
      section flipped from "use Node 22 LTS" to "sql.js is default".

---

## 4. Risks + open questions

| Risk | Mitigation |
|---|---|
| sql.js startup cost (loading the WASM module) adds latency to every harvest invocation | Measure. If significant, cache the module load across processes via a long-lived bridge — but deep-memory is per-invocation, so probably not worth it. |
| sql.js BLOB / binary data quirks (memory ArrayBuffer vs Buffer) | Likely not relevant — deep-memory's FTS5 columns are all TEXT/INTEGER. Confirm during port. |
| sql.js's `db.export()` returns the entire DB as a Uint8Array; for large indexes (> 10 MB) this could spike memory | Acceptable for v0.2.0 — deep-memory's index is small. Track via audit. |
| Backwards compatibility for users on the native backend who already have a v0.1.x index file | The SQLite file format is identical; sql.js can read it. Spot-test during port. |
| Adding sql.js to required `dependencies` means npm install always pays ~1MB WASM download | Acceptable trade for portability. Bundle size analysis goes in README. |

Open questions for the v0.2.0 author:

1. **Promote better-sqlite3 → fully drop, or keep as opt-in?** Recommend
   keep as opt-in with env flag — gives users a perf escape hatch without
   regressing the default path.
2. **Version bump shape**: v0.2.0 minor or v0.1.4 patch? Recommend v0.2.0
   minor because the install footprint (sql.js dep) changes meaningfully.
3. **Spec §13 (which doesn't exist yet) should document the backend probe**
   — add as a new short section to `docs/superpowers/specs/2026-05-20-deep-memory-design.md`.

---

## 5. Suggested implementation order

1. Land `scripts/lib/fts-index-sqljs.js` as a parallel module. Smoke-test
   against the existing fixtures (`tests/fixtures/*.json`).
2. Add a TEMPORARY backend-probe env var to `fts-index.js` that selects
   sqljs when `DEEP_MEMORY_FTS_BACKEND=sqljs`. Run the full test suite
   with this env set; fix any sqljs-specific issues until 252/252 pass.
3. Make sqljs the default (probe order: env > better-sqlite3 > sqljs →
   env > sqljs > better-sqlite3, with sqljs as the always-present fallback).
4. Delete the v0.1.2 graceful-degradation paths (`fts === null`,
   `FTS_DEGRADED_WARNING`, `cards.warnings` non-enumerable). Reuse the
   spawn-fork test scaffolding for "backend probe selects sqljs when
   better-sqlite3 absent" tests instead.
5. CI matrix: add `DEEP_MEMORY_FTS_BACKEND=sqljs` and
   `DEEP_MEMORY_FTS_BACKEND=better-sqlite3` rows to `.github/workflows/ci.yml`.
6. CHANGELOG + README + Troubleshooting flip + spec §13 added.
7. Bump version 0.1.3 → 0.2.0 in 3 manifests + manifest-drift CI check.
8. Cross-repo: update deep-suite marketplace.json sha + description +
   `node scripts/generate-reference-sections.js --write`.

---

## 6. References

- Current FTS5 code: `scripts/lib/fts-index.js` (47 lines incl. better-sqlite3 guard)
- Graceful degradation entry point: `scripts/harvest.js:24-58`
- Symmetric retrieve guard: `scripts/retrieve.js:11-37`
- Existing degraded-mode tests: `tests/harvest-fts-silent-disable.test.js`,
  `tests/retrieve-fts-degraded.test.js`
- sql.js project: https://github.com/sql-js/sql.js — verify v1.10+ ships FTS5.
- spec sections that constrain the port: §7.1 (mappers, untouched),
  §7.3 (lock/lease/event-key invariants — backend must respect),
  §8 (retrieval pipeline — Stage 0 SQL identical).
- Companion docs:
  - `docs/handoff-phase-4-6.md` — Phase 4/5/6 forward roadmap (writer
    integration, reasoning graph, dashboard telemetry).
  - `docs/handoff-v0.1.x-immediate.md` — v0.1.x patch series, shipped.
  - This file — v0.2.0 backend port.
