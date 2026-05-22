'use strict';
// scripts/lib/rrf-fusion.js
// γ.4 — Reciprocal Rank Fusion with composite (memory_id, project_id) key
// per PR2-F. Scale-free score fusion across BM25 + vector candidate streams.

function compositeKey(card) {
  return `${card.memory_id}|${card.project_id}`;
}

/**
 * RRF k=60 fusion across N candidate streams.
 * @param {Array<Array<{memory_id, project_id, ...}>>} streams - each stream
 *   ordered best-to-worst (rank 0 is most relevant).
 * @param {number} k - RRF tuning constant (default 60, matches agentmemory).
 * @returns {Array<{memory_id, project_id, score, sources}>}
 */
function rrfFuse(streams, k = 60) {
  const scores = new Map();      // composite key → fused score
  const cardByKey = new Map();   // composite key → representative card
  const sourcesByKey = new Map(); // composite key → Set of stream indices

  for (let s = 0; s < streams.length; s++) {
    const stream = streams[s] || [];
    for (let i = 0; i < stream.length; i++) {
      const card = stream[i];
      if (!card || !card.memory_id) continue;
      const key = compositeKey(card);
      scores.set(key, (scores.get(key) || 0) + 1 / (k + i + 1));
      cardByKey.set(key, card);
      const srcs = sourcesByKey.get(key) || new Set();
      srcs.add(s);
      sourcesByKey.set(key, srcs);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => {
      const c = cardByKey.get(key);
      return {
        memory_id: c.memory_id,
        project_id: c.project_id,
        score,
        sources: [...sourcesByKey.get(key)]
      };
    });
}

module.exports = { rrfFuse, compositeKey };
