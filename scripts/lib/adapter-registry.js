'use strict';
const { detectHost, adapterForHost } = require('./runtime-context');

function detect(adapter = 'auto', { env = process.env } = {}) {
  return adapter === 'auto' ? adapterForHost(detectHost(env)) : adapter;
}

module.exports = { detect };
