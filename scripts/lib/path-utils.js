'use strict';
const os = require('node:os');
const path = require('node:path');

const NON_RESOLVABLE_PATH = '[REDACTED]';

function expandHomePath(raw, { homeDir = os.homedir(), pathApi = path } = {}) {
  if (typeof raw !== 'string') return raw;
  if (raw === '~') return homeDir;
  if (!/^~[\\/]/.test(raw)) return raw;
  const segments = raw.slice(2).split(/[\\/]+/).filter(Boolean);
  return pathApi.join(homeDir, ...segments);
}

function resolvePersistedPath(raw, options = {}) {
  if (typeof raw !== 'string' || raw.includes(NON_RESOLVABLE_PATH)) return null;
  return expandHomePath(raw, options);
}

module.exports = { expandHomePath, resolvePersistedPath, NON_RESOLVABLE_PATH };
