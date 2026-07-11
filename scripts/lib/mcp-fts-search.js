'use strict';
const fs = require('node:fs');
const { v2LexicalIndexPath } = require('./v2-index-paths');
const { scanCards } = require('./card-scan-search');

const FALLBACK_WARNING = 'lexical_stream_fallback';

function makeFtsSearch(root, {
  loadFts = () => require('./fts-index'),
  io = fs,
  scanCardsImpl = scanCards,
} = {}) {
  let fts = null;
  try {
    fts = loadFts();
  } catch {
    // Loader diagnostics can contain native paths. The transport contract is a
    // bounded reason code, so no exception text crosses this boundary.
  }
  const dbPath = v2LexicalIndexPath(root);

  function fallback(request) {
    const scanned = scanCardsImpl({
      root,
      currentProjectId: request.currentProjectId,
      query: request.query,
      topK: request.topK,
      io,
    });
    return {
      rows: scanned.rows,
      stream: 'card-scan',
      warnings: [...new Set([...scanned.warnings, FALLBACK_WARNING])],
    };
  }

  return (request) => {
    if (!fts || !io.existsSync(dbPath)) return fallback(request);
    let index = null;
    try {
      index = fts.openIndex(dbPath);
      const rows = fts.search(index, request.query, {
        topN: request.topK,
        projectId: request.currentProjectId,
      });
      if (!Array.isArray(rows)) throw new TypeError('native lexical search returned a non-array');
      return { rows, stream: 'fts5', warnings: [] };
    } catch {
      return fallback(request);
    } finally {
      if (index) {
        try { fts.closeIndex(index); } catch { /* query result/fallback remains authoritative */ }
      }
    }
  };
}

module.exports = { makeFtsSearch, FALLBACK_WARNING };
