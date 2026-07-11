// scripts/lib/atomic-write.js (P8 fix — parent dir fsync AFTER rename)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UNSUPPORTED_DIRECTORY_FSYNC = new Set(['EPERM', 'EINVAL', 'EBADF', 'ENOTSUP']);

function fsyncDirectoryBestEffort(dir, io = fs) {
  let fd;
  try {
    fd = io.openSync(dir, 'r');
    io.fsyncSync(fd);
    return true;
  } catch (error) {
    if (error && UNSUPPORTED_DIRECTORY_FSYNC.has(error.code)) return false;
    throw error;
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }
}

function privateTempPath(target) {
  return `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
}

function writePrivateTemp(target, contents, verify) {
  const tmp = privateTempPath(target);
  let owned = false;
  let published = false;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    owned = true;
    try {
      fs.writeSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    const wrote = fs.readFileSync(tmp, 'utf8');
    verify(wrote);
    fs.renameSync(tmp, target);
    published = true;
    fsyncDirectoryBestEffort(path.dirname(target));
  } finally {
    if (owned && !published) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  }
}

function writeJsonAtomic(target, data) {
  const text = JSON.stringify(data, null, 2);
  writePrivateTemp(target, text, (wrote) => {
    if (wrote !== text) throw new Error('atomic JSON write readback mismatch (temp)');
    try { JSON.parse(wrote); }
    catch (error) { throw new Error(`atomic JSON write verify failed: ${error.message}`); }
  });
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
  writePrivateTemp(target, text, (wrote) => {
    if (wrote !== text) throw new Error('atomic text write readback mismatch (temp)');
  });
}

module.exports = { writeJsonAtomic, writeTextAtomic, fsyncDirectoryBestEffort };
