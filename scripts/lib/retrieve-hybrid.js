'use strict';
// scripts/lib/retrieve-hybrid.js
// γ.5 + γ.6 + γ.7 — Hybrid retrieval orchestrator combining FTS5 + vector
// candidates via RRF, then session-diversifying the fused result.
//
// γ.5 — runs both streams (FTS5 + vector) with privacy filter applied at
//        SQL level on both sides per spec §5.1 (privacy_level column, not
//        privacy_scope — R2-A column-name correction).
// γ.6 — sessionDiversify caps cards per session_id (max_per_session, default
//        3) per spec §5.6. Cards without session_id pass through naturally
//        (v0.1.x sibling-origin cards have no session_id).
// γ.7 — graceful matrix per spec §5.4: if @xenova absent OR embed model
//        mismatch, vector stream is skipped entirely; FTS5-only retrieval
//        proceeds with a warning. Caller surfaces warnings via cards.warnings[].

const { rrfFuse } = require('./rrf-fusion');
const { embedText, probeModelVersion } = require('./embed-model');
const { openIndex, searchVector } = require('./vector-index');

/**
 * γ.6 — session_id diversification (Stage 8 of 6-stage rerank extension).
 * Caps cards per session_id at maxPerSession. Cards lacking session_id
 * (v0.1.x sibling-origin) pass through unconditionally.
 */
function sessionDiversify(cards, maxPerSession) {
  const sessionCounts = new Map();
  const out = [];
  for (const card of cards) {
    const sid = card.session_id || null;
    if (sid === null) {
      out.push(card);
      continue;
    }
    const cnt = sessionCounts.get(sid) || 0;
    if (cnt < maxPerSession) {
      out.push(card);
      sessionCounts.set(sid, cnt + 1);
    }
  }
  return out;
}

/**
 * γ.7 — Determine which streams are available given runtime state.
 * @param {string} root - $DEEP_MEMORY_ROOT
 * @returns {{vector_available: boolean, warnings: string[]}}
 */
function probeStreams(root) {
  const warnings = [];
  const probe = probeModelVersion(root);
  if (probe.status === 'absent') {
    warnings.push('vector_stream_skipped: @xenova/transformers not installed; FTS5-only retrieval');
    return { vector_available: false, warnings };
  }
  if (probe.status === 'mismatch') {
    warnings.push(`vector_stream_skipped: model version mismatch (stored=${probe.stored} loaded=${probe.loaded}); run /deep-memory-audit --rebuild-vectors`);
    return { vector_available: false, warnings };
  }
  return { vector_available: true, warnings };
}

/**
 * γ.5 — full hybrid retrieval.
 * @param {object} args
 * @param {string} args.query - query text
 * @param {string} args.currentProjectId
 * @param {string} args.root - $DEEP_MEMORY_ROOT
 * @param {Function} args.ftsSearch - injected FTS5 search: ({query, currentProjectId, topK}) => [{memory_id, project_id, ...}]
 *                   (caller-provided to avoid coupling to scripts/lib/fts-index.js
 *                    which is being widened separately per γ.1)
 * @param {number} [args.topN=5] - final result count
 * @param {number} [args.topK=30] - per-stream candidate count
 * @param {object} [args.config] - { brief: { max_per_session } }
 * @returns {Promise<{memories: Array, warnings: string[], streams_used: string[]}>}
 */
async function runHybridRetrieve({ query, currentProjectId, root, ftsSearch, topN = 5, topK = 30, config = {} }) {
  const { vector_available, warnings } = probeStreams(root);
  const streamsUsed = [];

  // Stream A — FTS5 (always available unless caller passes null)
  let ftsStream = [];
  if (ftsSearch) {
    try {
      ftsStream = await ftsSearch({ query, currentProjectId, topK });
      streamsUsed.push('fts5');
    } catch (e) {
      warnings.push(`fts_stream_error: ${e.message}`);
    }
  } else {
    warnings.push('fts_stream_skipped: no ftsSearch callback provided');
  }

  // Stream B — vector (graceful skip if probe failed)
  let vectorStream = [];
  if (vector_available) {
    try {
      const queryVec = await embedText(query);
      if (queryVec) {
        const db = openIndex(root);
        if (db) {
          vectorStream = searchVector({ db, queryVector: queryVec, currentProjectId, topK });
          streamsUsed.push('vector');
          db.close();
        } else {
          warnings.push('vector_stream_skipped: better-sqlite3 unavailable');
        }
      } else {
        warnings.push('vector_stream_skipped: embedText returned null (model load failed)');
      }
    } catch (e) {
      warnings.push(`vector_stream_error: ${e.message}`);
    }
  }

  // RRF fusion across whichever streams exist
  const streams = [ftsStream, vectorStream].filter(s => s.length > 0);
  const fused = streams.length > 0 ? rrfFuse(streams) : [];

  // Stage 8 — session diversification (γ.6)
  const maxPerSession = (config.brief && config.brief.max_per_session) || 3;
  const diversified = sessionDiversify(fused, maxPerSession);

  return {
    memories: diversified.slice(0, topN),
    warnings,
    streams_used: streamsUsed
  };
}

module.exports = { runHybridRetrieve, sessionDiversify, probeStreams };
