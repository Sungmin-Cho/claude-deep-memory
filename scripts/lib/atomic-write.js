// scripts/lib/atomic-write.js (P8 fix — parent dir fsync AFTER rename)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeJsonAtomic(target, data) {
  const tmp = target + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  const dirFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  try { JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (e) {
    const quarantine = target + '.corrupt-' + Date.now();
    fs.renameSync(target, quarantine);
    throw new Error(`atomic write readback failed; quarantined to ${quarantine}: ${e.message}`);
  }
}

// Atomic write for raw text (e.g. config.yaml). Same tmp+fsync+rename+dir-fsync
// durability as writeJsonAtomic.
//
// Two concurrency-safety properties (deep-review round 2):
//   1. The temp file uses a per-write unique name (pid + random), so two
//      processes writing the same target never clobber a shared `.tmp`.
//   2. Integrity is verified by reading back the TEMP file (which is private to
//      this process) BEFORE the rename — never the live target afterwards. A
//      post-rename readback of the live file would race a concurrent writer and
//      could quarantine a perfectly valid config another process just wrote.
// The final rename is atomic, so concurrent writers degrade to benign
// last-writer-wins with the target always present and valid.
function writeTextAtomic(target, text) {
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Verify the bytes we just wrote (private temp) before publishing.
  let wrote;
  try {
    wrote = fs.readFileSync(tmp, 'utf8');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw new Error(`atomic text write verify failed: ${e.message}`);
  }
  if (wrote !== text) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw new Error('atomic text write readback mismatch (temp)');
  }
  fs.renameSync(tmp, target);
  const dirFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

module.exports = { writeJsonAtomic, writeTextAtomic };
