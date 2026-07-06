'use strict';
// scripts/lib/mcp-fts-search.js
// Builds the `ftsSearch` callback that runHybridRetrieve expects, wiring the
// MCP read tools (brief / smart_search / recall) to the real FTS5 lexical
// index instead of the previous `ftsSearch: null` (which made lexical retrieval
// a silent no-op). Mirrors scripts/retrieve.js's proven wiring: resolve
// <root>/indexes/lexical.sqlite, open → search → close, with graceful
// degradation when better-sqlite3 is unloadable or the index does not exist yet.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} root - $DEEP_MEMORY_ROOT
 * @returns {Function} ftsSearch: ({query, currentProjectId, topK}) => rows[]
 *
 * The callback is returned unconditionally (never null) so runHybridRetrieve
 * surfaces the *real* reason a stream came back empty:
 *   - driver unloadable → the callback throws → `fts_stream_error: FTS5 …`
 *   - index file absent  → the callback returns [] → honest empty result
 *     (no cards harvested yet), without creating an empty sqlite file
 */
function makeFtsSearch(root) {
  let fts = null;
  let loadError = null;
  try {
    // fts-index treats better-sqlite3 as a hard require (throws at load time
    // when the native binding is unavailable), so guard the require here.
    fts = require('./fts-index');
  } catch (e) {
    loadError = e && e.message ? e.message : String(e);
  }
  const dbPath = path.join(root, 'indexes', 'lexical.sqlite');

  return ({ query, currentProjectId, topK }) => {
    if (!fts) {
      throw new Error(`FTS5 lexical index unavailable (better-sqlite3 not loadable): ${loadError}`);
    }
    // retrieve.js guards existsSync before openIndex specifically to avoid
    // better-sqlite3 creating an empty DB for a project that never harvested.
    if (!fs.existsSync(dbPath)) {
      return [];
    }
    const idx = fts.openIndex(dbPath);
    try {
      return fts.search(idx, query, { topN: topK, projectId: currentProjectId });
    } finally {
      fts.closeIndex(idx);
    }
  };
}

module.exports = { makeFtsSearch };
