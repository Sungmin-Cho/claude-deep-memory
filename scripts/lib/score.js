// scripts/lib/score.js (P13 fix — SQLite FTS5 bm25() returns lower=better; INVERT normalization)
'use strict';

function bm25MinMax(rows) {
  if (!rows.length) return rows;
  if (rows.length === 1) return [{ ...rows[0], task_sim_norm: 1.0 }];
  const vals = rows.map((r) => r.bm25);
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return rows.map((r) => ({ ...r, task_sim_norm: 1.0 }));
  return rows.map((r) => ({ ...r, task_sim_norm: (max - r.bm25) / (max - min) }));
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function stalePenalty(reviewAfter, graceDays) {
  if (!reviewAfter) return 0;
  const ageMs = Date.now() - new Date(reviewAfter).getTime();
  const graceMs = graceDays * 86400 * 1000;
  return Math.max(0, Math.min(1, ageMs / graceMs));
}

function jaccard(a = [], b = []) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size || 1;
  return inter / uni;
}

function scoreCard(card, { project_profile = null, weights = { w_project_sim: 0.2, w_task_sim: 0.5, w_evidence: 0.3, w_stale_penalty: 0.1 }, audit = { stale_grace_days: 90 } } = {}) {
  let w = { ...weights };
  let project_sim_norm = 0;
  if (!project_profile) w.w_project_sim = 0;
  else {
    project_sim_norm = jaccard(project_profile.signature?.languages || [], card.project_languages || []);
  }
  const evidence_q = (card.confidence || 0) * Math.log(1 + (card.evidence_count || 0)) * (1 - (card.feedback?.rejected || 0) / ((card.feedback?.accepted || 0) + (card.feedback?.rejected || 0) + 1));
  const evidence_norm = sigmoid(evidence_q - 1.5);
  const stale_norm = stalePenalty(card.review_after, audit.stale_grace_days);

  const score = w.w_project_sim * project_sim_norm
              + w.w_task_sim * (card.task_sim_norm || 0)
              + w.w_evidence * evidence_norm
              - w.w_stale_penalty * stale_norm;

  return { score: Math.max(0, Math.min(1, score)), parts: { project_sim_norm, task_sim_norm: card.task_sim_norm || 0, evidence_norm, stale_norm } };
}

module.exports = { bm25MinMax, sigmoid, stalePenalty, jaccard, scoreCard };
