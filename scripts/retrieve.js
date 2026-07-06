// scripts/retrieve.js
//
// Stage-ordered retrieval pipeline (spec §8, R3 P16 — explicit stage order).
//
//   Stage 0  fts-index.search(query, {projectId, topN: N*3}) — BM25 overfetch + privacy scope
//   Stage 1  hard filter: status !== 'deprecated' + review_after age (drop deprecated)
//   Stage 2  bm25MinMax over the post-hard-filter set (score.js — inverts BM25 scale)
//   Stage 3  load full card payloads from cards/<type>/{global|<project_id>}/*.json
//   Stage 4  project_sim — Jaccard on languages/runtimes (missing-profile → w_project_sim=0)
//   Stage 5  evidence_quality — sigmoid(confidence × log(1+n) × …) via score.js#scoreCard
//   Stage 6  applicability guard — task tokens ∩ non_applicability.value Jaccard ≥ 0.5 → drop
//   Stage 7  diversity — per memory_type top diversity_per_type, same dedupe_key cluster 1 only
//   Stage 8  weighted score: w_project_sim·s + w_task_sim·t + w_evidence·e − w_stale_penalty·p
//
// Inputs:
//   task           — natural language task (required)
//   memoryRoot     — absolute path to ~/.deep-memory (resolved by caller)
//   projectProfile — parsed .deep-memory/project-profile.json (null = global-only)
//   topN, diversityPerType, weights, audit — config.yaml#retrieve overrides
//
// Output: { task, memories: [...], warnings: [...] }
'use strict';
const fs = require('node:fs');
const path = require('node:path');
// v0.1.2 — FTS5 graceful degradation. If better-sqlite3 native binding is
// unavailable (Node v26+ with immutable plugin cache), retrieve returns an
// empty result + explicit warning instead of hard-throwing at require-time.
// Symmetric with harvest.js — same Node environment must support both paths.
let _fts = null;
let _ftsLoadError = null;
try {
  _fts = require('./lib/fts-index');
} catch (e) {
  _ftsLoadError = e && e.message ? e.message : String(e);
}
const FTS_DEGRADED_WARNING_RETRIEVE =
  'FTS5 lexical index unavailable (better-sqlite3 not loadable in this Node ' +
  'environment). brief returns empty — re-run with Node 22 LTS, or wait for ' +
  'v0.2.0 sql.js fallback. See README.md > Troubleshooting.';
const { bm25MinMax, scoreCard } = require('./lib/score');
const { redactString } = require('./lib/redact');
// Card-state filters live in lib/card-filters.js so the MCP hybrid path
// (retrieve-hybrid.js) enforces the same Stage 1 / Stage 6 contract (R2 #3).
const {
  tokenize,
  loadCard,
  isNotDeprecated,
  passesApplicabilityGuard,
  APPLICABILITY_GUARD_THRESHOLD,
} = require('./lib/card-filters');

const DEFAULT_TOP_N = 8;
const DEFAULT_DIVERSITY_PER_TYPE = 2;
const DEFAULT_WEIGHTS = {
  w_project_sim: 0.2,
  w_task_sim: 0.5,
  w_evidence: 0.3,
  w_stale_penalty: 0.1,
};
const DEFAULT_AUDIT = { stale_grace_days: 90 };

/**
 * Stage 7 — diversity cap. For each memory_type, keep at most diversity_per_type
 * cards; within a type, cards sharing the same dedupe_key collapse to the
 * highest-scoring representative (input order is assumed score-desc).
 */
function applyDiversity(cards, diversityPerType) {
  const seenDedupe = new Set();
  const typeCount = new Map();
  const out = [];
  for (const c of cards) {
    const type = c.payload?.memory_type || 'unknown';
    const dk = c.payload?.dedupe_key;
    if (dk && seenDedupe.has(dk)) continue;
    const count = typeCount.get(type) || 0;
    if (count >= diversityPerType) continue;
    out.push(c);
    typeCount.set(type, count + 1);
    if (dk) seenDedupe.add(dk);
  }
  return out;
}

async function runRetrieve({
  task,
  memoryRoot,
  projectProfile = null,
  topN = DEFAULT_TOP_N,
  diversityPerType = DEFAULT_DIVERSITY_PER_TYPE,
  weights = DEFAULT_WEIGHTS,
  audit = DEFAULT_AUDIT,
} = {}) {
  if (!task) throw new Error('runRetrieve requires task');
  if (!memoryRoot) throw new Error('runRetrieve requires memoryRoot');

  const warnings = [];
  if (!projectProfile) {
    warnings.push('missing project-profile — w_project_sim forced to 0');
  }
  // v0.1.2 — degraded mode: fts-index module failed to load (better-sqlite3
  // native binding unavailable). Return empty result + explicit warning so the
  // brief renderer surfaces the actionable message to the user.
  if (!_fts) {
    // v0.1.3 — redact native loader error before exposing it (paths may leak).
    const causeRedacted = _ftsLoadError ? redactString(_ftsLoadError) : '';
    warnings.push(
      FTS_DEGRADED_WARNING_RETRIEVE +
        (causeRedacted ? ` (cause: ${causeRedacted})` : '')
    );
    return { task, memories: [], warnings };
  }
  const projectId = projectProfile?.project_id || null;
  const dbPath = path.join(memoryRoot, 'indexes', 'lexical.sqlite');
  if (!fs.existsSync(dbPath)) {
    warnings.push('no lexical index — run /deep-memory-harvest first');
    return { task, memories: [], warnings };
  }

  const idx = _fts.openIndex(dbPath);
  let rows = [];
  try {
    // Stage 0 — BM25 overfetch + privacy filter (in SQL)
    rows = _fts.search(idx, task, { topN, projectId });
  } finally {
    _fts.closeIndex(idx);
  }
  if (rows.length === 0) {
    return { task, memories: [], warnings };
  }

  // Stage 3 — load full payloads (deprecated/stale filtering reads card metadata)
  const loaded = rows
    .map((row) => ({ row, card: loadCard(memoryRoot, row) }))
    .filter((x) => x.card);
  if (loaded.length === 0) {
    warnings.push('FTS index references cards no longer on disk — consider /deep-memory-audit');
    return { task, memories: [], warnings };
  }

  // Stage 1 — hard filter (status != deprecated). review_after is converted to
  // stale_penalty in Stage 8 rather than a hard drop — old cards stay visible
  // but ranked down (spec §8 stale_grace_days).
  const survived = loaded.filter((x) => isNotDeprecated(x.card));

  // Stage 2 — bm25MinMax (invert SQLite scale; smaller raw bm25 = better)
  const rowsForNorm = survived.map((x) => ({ ...x.row, bm25: x.row.bm25 }));
  const normalized = bm25MinMax(rowsForNorm);
  for (let i = 0; i < survived.length; i++) {
    survived[i].row.task_sim_norm = normalized[i].task_sim_norm;
  }

  // Stage 6 — applicability guard (BEFORE scoring, so the score over a clean set)
  const taskTokens = tokenize(task);
  const guardSurvived = survived.filter((x) => passesApplicabilityGuard(x.card, taskTokens));

  // Stage 4+5+8 — weighted score per card
  const scored = guardSurvived.map((x) => {
    const card = x.card;
    const scoreInput = {
      project_languages: [], // populated below per-card when applicability carries language= hint
      task_sim_norm: x.row.task_sim_norm,
      confidence: card.payload.confidence,
      evidence_count: card.payload.evidence_summary?.length || 0,
      feedback: card.payload.feedback ? {
        accepted: card.payload.feedback.accepted_count || 0,
        rejected: card.payload.feedback.rejected_count || 0,
        inaccurate: card.payload.feedback.inaccurate_count || 0,
      } : {},
      review_after: card.payload.review_after,
    };
    // Pull language hints out of applicability for Stage 4 (project_sim)
    const langHints = (card.payload.applicability || [])
      .map((a) => (typeof a === 'string' ? a : a.value))
      .map((v) => /^language=(.+)$/.exec(v))
      .filter(Boolean)
      .map((m) => m[1]);
    scoreInput.project_languages = langHints;

    const s = scoreCard(scoreInput, {
      project_profile: projectProfile,
      weights,
      audit,
    });
    return { card, parts: s.parts, score: s.score, row: x.row };
  });

  // Stage 8 sort desc by score
  scored.sort((a, b) => b.score - a.score);

  // Stage 7 — diversity AFTER scoring so we keep the best representative per cluster
  const diverse = applyDiversity(
    scored.map((s) => ({ ...s.card, score: s.score, parts: s.parts })),
    diversityPerType
  );

  // Final top_n cut
  const top = diverse.slice(0, topN);

  return {
    task,
    memories: top,
    warnings,
  };
}

module.exports = {
  runRetrieve,
  loadCard,
  tokenize,
  passesApplicabilityGuard,
  applyDiversity,
  DEFAULT_TOP_N,
  DEFAULT_DIVERSITY_PER_TYPE,
  DEFAULT_WEIGHTS,
  DEFAULT_AUDIT,
  APPLICABILITY_GUARD_THRESHOLD,
};
