'use strict';
// scripts/lib/card-filters.js
// Card-state filters shared by the CLI retrieve pipeline (scripts/retrieve.js)
// and the MCP hybrid retrieval path (retrieve-hybrid.js) so both surfaces
// enforce the same contract: deprecated cards never surface (Stage 1 hard
// filter) and cards whose non_applicability overlaps the task are dropped
// (Stage 6 applicability guard).

const fs = require('node:fs');
const path = require('node:path');
const { jaccard } = require('./score');

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
function loadCard(memoryRoot, row) {
  const typeDir = path.join(memoryRoot, 'cards', row.memory_type);
  const projScope = row.project_id || 'global';
  const candidatePaths = [
    path.join(typeDir, projScope, row.memory_id + '.json'),
    path.join(typeDir, 'global', row.memory_id + '.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch { return null; }
    }
  }
  return null;
}

function readCardFile(memoryRoot, memoryType, scope, memoryId) {
  const p = path.join(memoryRoot, 'cards', memoryType, scope, memoryId + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
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
function locateCard(memoryRoot, row) {
  // R5 P1: a global row resolves from global/ ONLY — vector rows keep their
  // origin project_id even at privacy_level 'global', and probing that scope
  // first would let a same-id LOCAL card validate a stale global row for
  // every other project.
  const isGlobalRow = row.privacy_level === 'global' || !row.project_id;
  const scopes = isGlobalRow ? ['global'] : [row.project_id];
  let types = [];
  if (row.memory_type) {
    types = [row.memory_type];
  } else {
    try { types = fs.readdirSync(path.join(memoryRoot, 'cards')); } catch { return null; }
  }
  for (const t of types) {
    for (const s of scopes) {
      const card = readCardFile(memoryRoot, t, s, row.memory_id);
      if (card) return card;
    }
  }
  return null;
}

function isNotDeprecated(card) {
  return card.payload?.status !== 'deprecated';
}

/**
 * Stage 6 — applicability guard. The card carries a list of contexts where it
 * should NOT apply (`non_applicability[].value`). We tokenize each value, then
 * compare against the task tokens via Jaccard. If ANY non_applicability item
 * overlaps the task at ≥ 0.5 Jaccard, the card is dropped — applying it would
 * actively mislead.
 */
function passesApplicabilityGuard(card, taskTokens) {
  const nonApp = card.payload?.non_applicability || [];
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
