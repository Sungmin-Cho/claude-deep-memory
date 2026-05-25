// scripts/lib/atomic-write.js (P8 fix — parent dir fsync AFTER rename)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
// durability as writeJsonAtomic, with a byte-exact readback in place of the
// JSON re-parse (content is not JSON). A mismatch quarantines the file and
// throws, so a corrupt/partial write can never masquerade as success.
function writeTextAtomic(target, text) {
  const tmp = target + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  const dirFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  if (fs.readFileSync(target, 'utf8') !== text) {
    const quarantine = target + '.corrupt-' + Date.now();
    try { fs.renameSync(target, quarantine); } catch { /* best-effort */ }
    throw new Error(`atomic text write readback mismatch; quarantined to ${quarantine}`);
  }
}

module.exports = { writeJsonAtomic, writeTextAtomic };
