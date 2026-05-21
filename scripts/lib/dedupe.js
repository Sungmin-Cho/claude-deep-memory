'use strict';
const { createHash } = require('crypto');

/**
 * Canonicalise free-text for stable dedupe comparison.
 *   - lower-case
 *   - drop all non-alphanumeric, non-whitespace characters (punctuation, symbols)
 *   - collapse internal whitespace
 *   - trim
 *
 * STOP-WORDS ARE PRESERVED (F15 invariant): "use A for B" and "use A to B" must
 * remain distinct because the preposition often carries semantic intent.
 */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')  // ITEM-3-r4: Unicode-aware (was /[^a-z0-9\s]+/g)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hash an applicability set into a short stable seed. Accepts either:
 *   - string array: `["typescript", "react"]`
 *   - object array: `[{value:"typescript", source_id:"src_1", confidence:0.9}, ...]`
 *
 * Empty input → empty string (preserves equality with cards that have no applicability).
 */
function applicabilitySeedHash(applicability = []) {
  if (!applicability.length) return '';
  const seed = applicability
    .map((a) => (typeof a === 'string' ? a : a.value))
    .filter(Boolean)
    .map((s) => s.toLowerCase().trim())
    .sort()
    .join('|');
  return createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

/**
 * Compute the dedupe key for a memory card:
 *   sha256(`${memory_type}|${normalize(claim)}|${applicabilitySeed}`)
 *
 * F22 invariant: memory_type prefix guarantees cross-type isolation. Two cards with
 * identical claim text but different types (e.g. failure-case vs pattern) MUST hash
 * to different keys so they don't collapse on merge.
 */
function dedupeKey(memoryType, claim, applicability = []) {
  const norm = normalize(claim);
  const seed = applicabilitySeedHash(applicability);
  const input = `${memoryType}|${norm}|${seed}`;
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

module.exports = { normalize, dedupeKey, applicabilitySeedHash };
