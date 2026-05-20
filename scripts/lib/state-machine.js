'use strict';

/**
 * Cap on `payload.status_history[]` entries — retention sliding window. Keeps the
 * most recent MAX_HISTORY transitions; older ones are dropped during trim.
 */
const MAX_HISTORY = 10;

/**
 * Evaluate the next status for a memory card based on its current state and the
 * tally of supporting / contradicting evidence. Implements 4 automatic transitions:
 *
 *   - candidate    → validated     when evidence_summary.length >= 2 AND contradicting == 0
 *   - candidate    → contradicted  when contradicting >= 1
 *   - validated    → contradicted  when contradicting >= 1
 *   - validated    → deprecated    when review_after is in the past
 *   - contradicted → candidate     when supporting >= 2 (recovery loop)
 *
 * Note: the deprecated transition (5th, manual) is NOT handled here — it's invoked
 * explicitly via `/deep-memory-audit --deprecate <id>` and recorded as `by: "manual:..."`.
 *
 * `trimHistory: true` caps `card.payload.status_history` at MAX_HISTORY (slice from tail).
 * Returns `{current, next, transitioned, by, trimmed}` — callers persist the result.
 */
function evaluateTransitions(card, { trimHistory = false } = {}) {
  const status = card.status;
  const evidence = (card.payload?.evidence_summary || []).length;
  const contradicting = card.contradicting || 0;
  const supporting = card.supporting || 0;
  let next = status;
  let by = null;

  if (status === 'candidate') {
    if (contradicting >= 1) {
      next = 'contradicted';
      by = 'auto:contradicting>=1';
    } else if (evidence >= 2) {
      next = 'validated';
      by = 'auto:evidence>=2';
    }
  } else if (status === 'validated') {
    if (contradicting >= 1) {
      next = 'contradicted';
      by = 'auto:contradicting>=1';
    } else if (
      card.payload?.review_after &&
      new Date(card.payload.review_after) < new Date()
    ) {
      next = 'deprecated';
      by = 'auto:review_after_past';
    }
  } else if (status === 'contradicted') {
    if (supporting >= 2) {
      next = 'candidate';
      by = 'auto:new_supporting>=2';
    }
  }

  let trimmed = card.payload?.status_history || [];
  if (trimHistory && trimmed.length > MAX_HISTORY) {
    trimmed = trimmed.slice(-MAX_HISTORY);
  }

  return {
    current: status,
    next,
    transitioned: next !== status,
    by,
    trimmed,
  };
}

module.exports = { evaluateTransitions, MAX_HISTORY };
