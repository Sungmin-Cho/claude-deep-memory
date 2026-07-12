'use strict';
const path = require('node:path');

function v2LexicalIndexPath(memoryRoot) {
  return path.join(memoryRoot, 'indexes', 'v2', 'lexical.sqlite');
}

module.exports = { v2LexicalIndexPath };
