'use strict';
// scripts/lib/card-filters.js
// Card-state filters shared by the CLI retrieve pipeline (scripts/retrieve.js)
// and the MCP hybrid retrieval path (retrieve-hybrid.js) so both surfaces
// enforce the same contract: deprecated cards never surface (Stage 1 hard
// filter) and cards whose non_applicability overlaps the task are dropped
// (Stage 6 applicability guard).

const fs = require('node:fs');
const { jaccard } = require('./score');
const { isValidProjectId } = require('./validate-project-id');
const { walkContainedCardTypes, readContainedCard } = require('./card-paths');

const APPLICABILITY_GUARD_THRESHOLD = 0.5;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')  // ITEM-3-r3: Unicode-aware (was /[^a-z0-9\s]+/g)
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Stage 3 — read the full card payload from disk. Cards live at
 * `cards/<memory_type>/{global|<project_id>}/<memory_id>.json`. We try the
 * project_id scope first, then global; the FTS5 row already tells us the
 * memory_type so we don't have to walk the whole tree.
 */
function findContainedCard(memoryRoot, row, {
  io = fs,
  platform = process.platform,
  currentProjectId,
  budget = null,
} = {}) {
  if (!row || typeof row !== 'object' || typeof row.memory_id !== 'string') return null;
  const isGlobalRow = row.privacy_level === 'global' || !row.project_id;
  const rowProjectId = isGlobalRow ? null : row.project_id;
  if (rowProjectId !== null && !isValidProjectId(rowProjectId)) return null;
  if (currentProjectId !== undefined) {
    if (currentProjectId !== null && !isValidProjectId(currentProjectId)) return null;
    if (!isGlobalRow && currentProjectId !== rowProjectId) return null;
  }

  const wantedScope = isGlobalRow ? 'global' : rowProjectId;
  const readType = (type) => {
    const read = readContainedCard({
      root: memoryRoot,
      currentProjectId: rowProjectId,
      type,
      scope: wantedScope,
      file: `${row.memory_id}.json`,
    }, { io, platform, budget });
    if (!read.value) return null;
    const payload = read.value.payload || read.value;
    if (payload.memory_id !== row.memory_id || payload.memory_type !== type) return null;
    return read.value;
  };

  if (typeof row.memory_type === 'string' && row.memory_type) {
    return readType(row.memory_type);
  }

  let found = null;
  walkContainedCardTypes({
    root: memoryRoot, io, platform, budget,
    onType(descriptor) {
      found = readType(descriptor.type);
      return found ? false : !(budget && budget.exhausted);
    },
  });
  return found;
}

function loadCard(memoryRoot, row, options) {
  const card = findContainedCard(memoryRoot, row, options);
  if (!card) return null;
  return card.payload ? card : { payload: card };
}

/**
 * Scope-strict card lookup for the MCP hybrid path (R4 #2). memory_id is
 * deterministic from type/claim — NOT from scope — so a same-id GLOBAL card
 * must never "validate" a stale LOCAL index row whose scoped card was deleted:
 * a local row resolves ONLY from its own project scope. Rows that are
 * themselves global-privacy (or scope-less) may resolve from the global
 * directory. Also handles rows lacking `memory_type` (vector-index rows carry
 * only memory_id/project_id/privacy_level) by probing each `cards/<type>/`
 * directory — the type dir set is a handful, so the scan is bounded.
 * (The CLI pipeline's loadCard keeps its project→global fallback: it renders
 * the LOADED card's payload, not the index row, so no stale row content can
 * surface through it.)
 */
function locateCard(memoryRoot, row, options) {
  return findContainedCard(memoryRoot, row, options);
}

function isNotDeprecated(card) {
  return (card.payload || card).status !== 'deprecated';
}

/**
 * Stage 6 — applicability guard. The card carries a list of contexts where it
 * should NOT apply (`non_applicability[].value`). We tokenize each value, then
 * compare against the task tokens via Jaccard. If ANY non_applicability item
 * overlaps the task at ≥ 0.5 Jaccard, the card is dropped — applying it would
 * actively mislead.
 */
function passesApplicabilityGuard(card, taskTokens) {
  const nonApp = (card.payload || card).non_applicability || [];
  for (const na of nonApp) {
    const naTokens = tokenize(na.value);
    if (naTokens.length === 0) continue;
    if (jaccard(taskTokens, naTokens) >= APPLICABILITY_GUARD_THRESHOLD) {
      return false;
    }
  }
  return true;
}

module.exports = {
  tokenize,
  loadCard,
  locateCard,
  isNotDeprecated,
  passesApplicabilityGuard,
  APPLICABILITY_GUARD_THRESHOLD,
};
