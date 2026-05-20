# deep-memory — Handoff for Phases 4 / 5 / 6 (post-v0.1.0)

This is the post-v0.1.0 follow-up roadmap for `deep-memory` itself. The
companion document
[`/Users/sungmin/Dev/claude-plugins/deep-work/docs/deep-memory-integration-handoff.md`](/Users/sungmin/Dev/claude-plugins/deep-work/docs/deep-memory-integration-handoff.md)
(Task 8.2, cross-repo) covers what `deep-work` needs to do to consume the brief.

This file documents three follow-up phases that intentionally sit outside the
MVP boundary, plus a closing checklist that must be checked off before each
phase starts.

---

## v0.1.0 scope summary (what shipped)

| Phase | Delivered | Tests |
|---|---|---|
| 0 — Skeleton | manifests (Claude + Codex), CLAUDE.md, AGENTS.md, READMEs, LICENSE, package.json, `.gitignore`, better-sqlite3 install probe | (manifest-drift) |
| 1 — Schemas + lib | 4 schemas (Option (b) envelope-compat), 11 lib modules (envelope, redact 3-pass, dedupe, state-machine, lock + StaleLockError, atomic-write + fsync, source-hash, score + bm25MinMax inversion (P13), preflight, adapter-registry, llm-bridge skeleton) | 35 PASS |
| 2 — Harvest | `init.js` (preflight + project-profile + memory_root scaffold), `harvest.js` (5 mapper Step A + Pass 1 redact + persist with project lease + global lock + idempotent event_key + FTS5 upsert hook) | +12 (47) |
| 3a — Distill rule | 5 mappers (review-recurring, evolve-insights, work-receipt, docs-scan, wiki-index), STEP_A_MAPPERS registry, quarantine for F1 violations | +11 (58) |
| 3b — Distill sub-agent | `agents/memory-distiller.md` (Read-only), 3 adapters (claude-agent / codex-bash / stdin-fallback) + gemini-sdk stub, recorded fixtures, llm-bridge with Ajv strict validation (F5) + typed errors (SCHEMA_VIOLATION / TIMEOUT / ADAPTER_NOT_WIRED), `harvest.js` Step B integration with Pass 2 + Pass 3 redaction and Step A authority invariant | +33 (91) |
| 4 — Brief | `fts-index.js` (FTS5, privacy-scope-filtered SQL), `retrieve.js` (6-stage ranking pipeline with explicit order — P16), `brief-format.js` (JSON + Markdown render with F2 fallback defaults), `brief.js` entry, cross-ref invariant test (P17) | +31 (122) |
| (refactor) | envelope-compat decision Option (b) applied — source_artifacts split into suite-shape + `payload.deep_memory_provenance` | unchanged |
| 5 — Audit | `audit.js` (Ajv strict on every card, applyAutoTransitions with state-machine, detectStaleLocks + `--unlock`, detectDedupeCollisions per spec §6.4, detectSourceRenames via content_hash, detectStaleProfile, `promoteCard` with lock interaction), aggregated `run()` + CLI entry | +38 (160) |
| 6 — CI | `.github/workflows/ci.yml` (Node 22 matrix, npm ci, validate-manifest, npm test, manifest-drift gate as separate job) | (CI) |

**Total:** 160 tests passing, 0 failing. better-sqlite3 hard dependency for v0.1.0.

Tasks deferred from MVP (require user-driven decisions or sibling plugins):

- **Task 3b.7** — stdin-fallback batch mode prototype + Q5 decision gate (see Phase 3b-prelude below)
- **Task 7.x** — suite integration entries in `deep-suite/marketplace.json` × 2 + `suite-extensions.json` (cross-repo, requires user consent — see Phase 6 below)
- **Task 8.2** — `deep-work` consumer-side handoff (cross-repo — done from this doc's sibling)

---

## Phase 4 — deep-review / deep-evolve writer integration (separate PRs)

Goal: existing sibling plugins start *writing back* into the memory store with
richer signal, not just letting `/deep-memory-harvest` scrape their artifacts.

1. **deep-review writer**
   - On review start: call `/deep-memory-brief "<task>"` and inline the top-3
     `failure-case` cards into the review prompt header (so the reviewer sees
     prior incidents).
   - On review end: emit a new `recurring-findings` artifact entry for any
     finding that fires for the second time in 30 days. The harvest pipeline
     will pick this up at the next scan; no direct memory write — the
     append-only event log stays the source of truth.

2. **deep-evolve writer**
   - On evolution init: query `experiment-outcome` memories with
     `q_delta > 0.1` filtered by current project's `project_signature` (jaccard
     on languages/topology). Surface these as strategy *seeds* in the candidate
     pool — implementation should preserve evolution's existing diversity
     constraints (no over-seeding from memory).
   - On evolution write-back: emit `evolve-insights` entries with the
     `q_delta` of the chosen strategy.

3. **Both plugins**
   - PRs land independently of any `deep-memory` repo change — the harvest
     mappers in v0.1.0 already understand the artifact shapes.

---

## Phase 5 — Reasoning Graph (new sub-system)

Goal: turn the flat card store into a queryable lineage graph so
"why did the agent recommend X" becomes traceable across plugins.

1. **Storage**
   - `~/.deep-memory/graph/nodes.jsonl` — append-only node log
     (memory cards, project profiles, source artifacts as nodes)
   - `~/.deep-memory/graph/edges.jsonl` — append-only edge log
     (cited-by, derived-from, contradicts, supersedes)
   - Indexed into a SQLite table separate from FTS5 (recursive CTE friendly)

2. **Query**
   - `/deep-memory graph <memory_id> [--depth=N]` — N-hop lineage walk
     with cycle detection
   - `/deep-memory rebuild` — drop + repopulate graph from nodes/edges JSONL
     (consistency recovery; analogous to `/deep-memory-audit --rebuild-index`
     for FTS5)

3. **Open questions for Phase 5 entry gate** (close before starting):
   - Edge cardinality budget — at 1k cards × 5 edges/card, walks stay
     sub-millisecond; needs benchmark on real corpora before introducing.
   - Privacy scope on graph edges (local→local OK, local→global edge is a
     downgrade risk — defer until edge schema audit lands).

---

## Phase 6 — Dashboard telemetry

Goal: `deep-dashboard` plugin aggregates 8 metrics from deep-memory:

1. `cards_total` — count of cards in store
2. `cards_by_type` — breakdown by memory_type (5 enum values)
3. `cards_by_status` — breakdown by status (candidate / validated / contradicted / deprecated)
4. `harvest_rate` — cards created per day (last 30 days, rolling)
5. `brief_recall_quality` — accepted_count / (accepted + rejected) — needs feedback hook
6. `dedupe_collision_rate` — per-week count from `/deep-memory-audit`
7. `redaction_hit_rate` — `redaction_metadata.chars_masked` summed by week
8. `stale_card_ratio` — % of validated cards past `review_after`

**Memory debt alert**: when `stale_card_ratio` > 30% for 7 consecutive days,
dashboard surfaces a "memory debt high — run /deep-memory-audit" panel.

---

## Phase entry checklists (must close before starting)

### Before Phase 4 (writers)
- [ ] Measure dedupe collision rate on a real corpus (≥ 100 cards, ≥ 5 projects).
      If collision rate > 5%, semantic dedupe (embeddings) becomes
      higher-priority than this phase — re-prioritize.
- [ ] Confirm `deep-review` + `deep-evolve` PR cadence does not collide with
      `/deep-memory-harvest` cadence (artifact schema versioning).

### Before Phase 5 (graph)
- [ ] Measure feedback signal volume — if Phase 6 metric #5 returns
      `accepted_count = 0` after 30 days, the graph is rich but signal-less.
      Resolve the feedback hook (see deep-work integration handoff §5) first.
- [ ] Benchmark recursive CTE walk on 1k-card seed corpus — sub-millisecond
      is the target; SQLite EXPLAIN QUERY PLAN review required.

### Before Phase 6 (dashboard)
- [ ] Measure rule-based redaction false-negative rate on a recorded fixture
      (target: < 1%). If higher, LLM second-pass redaction (currently OOS)
      becomes higher-priority than dashboard telemetry — re-prioritize.

---

## Explicit out-of-scope (still)

Carried forward from spec §16:

- semantic embedding / vector DB
- semantic dedupe (same meaning, different wording)
- LLM second-pass redaction (MVP rule-based 3-pass is the boundary)
- team / org privacy scope (MVP: `local` + `global` only)
- automatic SessionStart / Stop hooks
- per-card encryption at rest

## R3 review-loop lesson — "false confidence"

The Round 1 `deep-review-loop` over the v0.1.0 plan caught a class of error
the original plan introduced as a self-review §1 claim of "spec coverage
100%". Four independent reviewers (Opus / Codex review / Codex adversarial /
agy) unanimously REQUEST_CHANGES'd that claim — Phase 3a (5 mapper), Phase 5
(7 sub-feature), and Phase 4 were all outlines, with harvest.js retrofit
(Task 2.5) entirely absent. **Lesson:** at least one external reviewer must
sign off before plan execution begins. The plan should not be its own
final reviewer.

For subsequent phases (4 / 5 / 6 here), the same gate applies — no entry
without an external review of the phase plan.
