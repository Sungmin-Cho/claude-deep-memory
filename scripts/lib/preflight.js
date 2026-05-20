// scripts/lib/preflight.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function preflight(memoryRoot, { allowNetworkRoot = false } = {}) {
  const result = { ok: true, warnings: [], errors: [], resolved: null, network: false, readOnly: false };
  fs.mkdirSync(memoryRoot, { recursive: true });
  result.resolved = fs.realpathSync(memoryRoot);
  const probe = path.join(result.resolved, '.preflight-' + Date.now());
  try {
    const fd = fs.openSync(probe, 'w');
    fs.writeSync(fd, 'ok');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  } catch (e) {
    result.readOnly = true;
    result.warnings.push(`memory_root read-only: ${e.message}. brief-only mode.`);
  }
  if (/^\/Volumes\//.test(result.resolved) || /^\/mnt\//.test(result.resolved) || /^\/net\//.test(result.resolved)) {
    result.network = true;
    if (!allowNetworkRoot) {
      result.ok = false;
      result.errors.push(`memory_root looks like network mount (${result.resolved}). Pass --allow-network-root to override.`);
    } else {
      result.warnings.push(`memory_root on network mount: ${result.resolved} (allowed by --allow-network-root).`);
    }
  }
  return result;
}

module.exports = { preflight };
