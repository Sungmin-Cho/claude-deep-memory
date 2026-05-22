'use strict';
// scripts/lib/vector-index.js
// γ.2 — Vector index storage + brute-force cosine search per spec §5.2.
// Composite (memory_id, project_id) PRIMARY KEY closes the C-R1 vector-side
// (full v0.1.x FTS5 widening — γ.1 — deferred to v0.3.x; this module starts
// with the composite key, so vector retrieval is C-R1-safe even if FTS5
// retains the single-key bug).

const fs = require('node:fs');
const path = require('node:path');

// Lazy require — better-sqlite3 may be absent; sql.js fallback comes via
// existing scripts/lib/fts-index.js plumbing. For γ.2 simplification we use
// better-sqlite3 directly; sql.js fallback wiring is a v0.3.x task (already
// covered for FTS5 lexical index in v0.2.0).
let SqliteCtor = null;
function getSqlite() {
  if (SqliteCtor !== null) return SqliteCtor;
  try {
    SqliteCtor = require('better-sqlite3');
  } catch {
    SqliteCtor = false;
  }
  return SqliteCtor;
}

function openIndex(root) {
  const Sqlite = getSqlite();
  if (!Sqlite) return null;
  const indexesDir = path.join(root, 'indexes');
  fs.mkdirSync(indexesDir, { recursive: true });
  const dbPath = path.join(indexesDir, 'vector.sqlite');
  const db = new Sqlite(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_vectors (
      memory_id     TEXT NOT NULL,
      project_id    TEXT NOT NULL,
      privacy_level TEXT NOT NULL DEFAULT 'local',
      embedding     BLOB NOT NULL,
      dim           INTEGER NOT NULL DEFAULT 384,
      embedded_at   TEXT NOT NULL,
      embed_model   TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
      PRIMARY KEY (memory_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_card_vectors_project
      ON card_vectors(project_id, privacy_level);
  `);
  return db;
}

function upsertVector(db, { memory_id, project_id, privacy_level, embedding, embed_model }) {
  if (!db) return false;
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const stmt = db.prepare(`
    INSERT INTO card_vectors (memory_id, project_id, privacy_level, embedding, dim, embedded_at, embed_model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, project_id) DO UPDATE SET
      privacy_level = excluded.privacy_level,
      embedding = excluded.embedding,
      dim = excluded.dim,
      embedded_at = excluded.embedded_at,
      embed_model = excluded.embed_model
  `);
  stmt.run(
    memory_id,
    project_id,
    privacy_level || 'local',
    buf,
    embedding.length,
    new Date().toISOString(),
    embed_model || 'Xenova/all-MiniLM-L6-v2'
  );
  return true;
}

function cosineSim(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  // Both vectors are normalized (output.normalize: true), so cosine = dot.
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Brute-force cosine search.
 * @param {object} args - { db, queryVector, currentProjectId, topK }
 * @returns {Array<{memory_id, project_id, score, privacy_level}>}
 */
function searchVector({ db, queryVector, currentProjectId, topK = 30 }) {
  if (!db) return [];
  // Privacy filter at SQL level per spec §5.1 (PR2-F + R2-A column name fix):
  // privacy_level = 'global' OR project_id = currentProjectId.
  const rows = db.prepare(`
    SELECT memory_id, project_id, privacy_level, embedding, dim
    FROM card_vectors
    WHERE privacy_level = 'global' OR project_id = ?
  `).all(currentProjectId);
  const scored = [];
  for (const row of rows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dim);
    scored.push({
      memory_id: row.memory_id,
      project_id: row.project_id,
      privacy_level: row.privacy_level,
      score: cosineSim(queryVector, vec)
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function closeIndex(db) {
  if (db && typeof db.close === 'function') db.close();
}

module.exports = { openIndex, upsertVector, searchVector, closeIndex, cosineSim };
