'use strict';
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/normalize-generated-bundle.js <bundle-path>');
  process.exit(1);
}

const absolute = path.resolve(target);
const source = fs.readFileSync(absolute, 'utf8');
const normalized = source.replace(/[ \t]+$/gm, '');
if (normalized !== source) fs.writeFileSync(absolute, normalized);
