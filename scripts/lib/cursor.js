'use strict';
// scripts/lib/cursor.js
// β.1 — byte-offset cursor file r/w + advance per spec §3.4.3 + R2-B + R4-B fixes.
//
// File format: `<YYYY-MM>.jsonl:<byte_offset>` (one file per project under
// $DEEP_MEMORY_ROOT/.last-distill-cursor/<project_id>).
//
// Atomic write: temp+rename pattern. Monotonic within same file; cross-file
// (forward rollover) always advances (lex check not enforced — caller
// supplies forward-moving file names per Stage 6 contract).

const fs = require('node:fs');
const path = require('node:path');

function cursorPath(root, projectId) {
  return path.join(root, '.last-distill-cursor', projectId);
}

/**
 * @param {string} root - $DEEP_MEMORY_ROOT
 * @param {string} projectId
 * @returns {{file: string, offset: number} | null}
 */
function readCursor(root, projectId) {
  try {
    const text = fs.readFileSync(cursorPath(root, projectId), 'utf8').trim();
    const idx = text.lastIndexOf(':');
    if (idx < 0) return null;
    const file = text.slice(0, idx);
    const offset = parseInt(text.slice(idx + 1), 10);
    if (!file || Number.isNaN(offset)) return null;
    return { file, offset };
  } catch {
    return null;
  }
}

/**
 * Atomic write via tmp + rename. Always overwrites — caller is responsible for
 * monotonicity check (use advanceTo for that).
 */
function writeCursor(root, projectId, file, offset) {
  const p = cursorPath(root, projectId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, `${file}:${offset}\n`);
  fs.renameSync(tmp, p);
}

/**
 * Forward-only cursor advance. Within the same file, offset must be GREATER
 * than the existing offset (regression refused). Cross-file (new month
 * filename) always advances unconditionally — the caller (Stage 6 of
 * §4.5 distill pipeline) is responsible for invoking advanceTo only with
 * forward-moving file names.
 */
function advanceTo(root, projectId, file, offset) {
  const existing = readCursor(root, projectId);
  if (existing) {
    if (existing.file === file && existing.offset >= offset) {
      // Same-file regression — silent no-op (monotonic invariant).
      return;
    }
  }
  writeCursor(root, projectId, file, offset);
}

module.exports = { readCursor, writeCursor, advanceTo };
