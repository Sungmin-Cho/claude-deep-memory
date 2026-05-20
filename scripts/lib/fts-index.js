// scripts/lib/fts-index.js
//
// FTS5 lexical retrieval module for deep-memory cards. v0.1.0 MVP treats
// better-sqlite3 as a HARD dependency — the Phase 0 install probe
// (scripts/check-sqlite.js) must pass before any /deep-memory-harvest or
// /deep-memory-brief invocation. A sql.js WASM fallback wrapper is deferred
// to Phase 4+ (see docs/handoff-phase-4-6.md).
//
// Schema (FTS5 virtual table):
//   memory_id      UNINDEXED — stable id used by Step 3 to load full payload
//   memory_type    UNINDEXED — used by Stage 7 diversity cap
//   privacy_level  UNINDEXED — 'local' | 'global', driving the WHERE filter
//   project_id     UNINDEXED — empty string for global cards
//   claim, tags, applicability, search_keywords — INDEXED (BM25 search columns)
//
// Search semantics (spec §8):
//   privacy_level = 'global' OR project_id = ?  → local cards visible only to
//   the same project, global cards to all. The filter is applied in SQL, not
//   in the JS caller, so privacy scope can NOT be bypassed by reading raw rows.
//
// BM25 invariant (P13): SQLite FTS5 returns bm25() values where SMALLER = BETTER
// match (negative-log-likelihood). The caller MUST pass the result through
// score.js#bm25MinMax to invert the scale before combining with other weights.
'use strict';

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error(
    `deep-memory v0.1.0 requires better-sqlite3 (native module). ` +
    `Install build tools or use a Node image with prebuilt binaries. ` +
    `Future versions (Phase 4+) will add a sql.js WASM wrapper — ` +
    `see docs/handoff-phase-4-6.md.\nOriginal error: ${e.message}`
  );
}

const DRIVER_NAME = 'better-sqlite3';

function openIndex(filepath) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const db = new Database(filepath);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cards USING fts5(
      memory_id UNINDEXED,
      memory_type UNINDEXED,
      privacy_level UNINDEXED,
      project_id UNINDEXED,
      claim,
      tags,
      applicability,
      search_keywords
    );
  `);
  return { driver: DRIVER_NAME, db };
}

/**
 * Insert-or-replace a card row. Tolerates both shapes:
 *   - wrapped: { envelope, payload: {memory_id, ...} }  (post-buildCardFromDraft)
 *   - flat:    { memory_id, memory_type, ... }          (legacy / direct tests)
 *
 * projectId is taken from (in order):
 *   1. opts.projectId (explicit caller intent)
 *   2. card.project_id (flat-shape top-level)
 *   3. payload.project_id (wrapped legacy)
 *   4. '' (empty string — used for global-scope rows; FTS WHERE clause matches
 *      `project_id = ?` so callers querying global pass projectId: '')
 */
function upsertCard(idx, card, { projectId = null } = {}) {
  const p = card.payload || card;
  const pid = projectId !== null ? projectId : (card.project_id || p.project_id || '');
  const tagsText = (p.tags || []).join(' ');
  const applicabilityText = (p.applicability || [])
    .map((a) => (typeof a === 'string' ? a : a.value))
    .filter(Boolean)
    .join(' ');
  const keywordsText = (p.search_keywords || []).join(' ');

  idx.db.prepare('DELETE FROM cards WHERE memory_id = ?').run(p.memory_id);
  idx.db
    .prepare(
      `INSERT INTO cards (memory_id, memory_type, privacy_level, project_id, claim, tags, applicability, search_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.memory_id, p.memory_type, p.privacy_level || 'local', pid, p.claim, tagsText, applicabilityText, keywordsText);
}

/**
 * Sanitize an FTS5 MATCH query — SQLite FTS5 treats colon, dash, and quote
 * characters as syntax. We strip them and collapse whitespace; punctuation
 * outside [a-z0-9 ] becomes a space. Empty result → returns a sentinel that
 * matches nothing (so `search('')` returns [] instead of throwing).
 */
function sanitizeQuery(q) {
  const cleaned = String(q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '__no_match_sentinel__';
}

/**
 * Stage 0 of the retrieval pipeline. Overfetches `topN × 3` rows so subsequent
 * stages (hard filter, project_sim, evidence quality, applicability guard,
 * diversity) have headroom before the final top_n cut.
 *
 * Returns rows with raw `bm25` column attached. Pass through `score.bm25MinMax`
 * before combining with other weights.
 */
function search(idx, query, { topN = 8, projectId = null } = {}) {
  const matchQ = sanitizeQuery(query);
  const limit = Math.max(1, topN * 3);
  const pid = projectId === null ? '' : projectId;
  const rows = idx.db
    .prepare(
      `SELECT memory_id, memory_type, privacy_level, project_id, claim,
              tags, applicability, search_keywords,
              bm25(cards) AS bm25
       FROM cards
       WHERE cards MATCH ?
         AND (privacy_level = 'global' OR project_id = ?)
       ORDER BY bm25 ASC
       LIMIT ?`
    )
    .all(matchQ, pid, limit);
  return rows;
}

function closeIndex(idx) {
  if (idx && idx.db && typeof idx.db.close === 'function') idx.db.close();
}

module.exports = { openIndex, upsertCard, search, closeIndex, sanitizeQuery, DRIVER_NAME };
