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

module.exports = { writeJsonAtomic };
