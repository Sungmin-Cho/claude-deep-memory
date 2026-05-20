// scripts/lib/source-hash.js
'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');

function hashContent(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

function hashFile(filepath) {
  return hashContent(fs.readFileSync(filepath));
}

module.exports = { hashContent, hashFile };
