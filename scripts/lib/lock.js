// scripts/lib/lock.js (P9 fix — typed STALE_LOCK propagates instead of being swallowed)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STALE_MS = 5 * 60 * 1000;
const BACKOFF_MS = 50;
const MAX_RETRIES = 60;

class StaleLockError extends Error {
  constructor(lockPath, meta) {
    super(`Stale lock detected: ${lockPath} (created_at=${meta.created_at}, pid=${meta.pid}). Run /deep-memory-audit --unlock to break.`);
    this.code = 'STALE_LOCK';
    this.lockPath = lockPath;
    this.meta = meta;
  }
}

async function acquire(lockPath, { operation = 'unknown' } = {}) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(lockPath);
      const metaPath = path.join(lockPath, 'metadata.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        pid: process.pid, host: os.hostname(),
        created_at: new Date().toISOString(),
        operation,
      }, null, 2));
      return { lockPath, metaPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // P9: only swallow JSON parse / ENOENT during metadata read; propagate StaleLockError
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
      } catch (readErr) { /* malformed or transiently missing — backoff retry */ }
      if (meta && isStale(meta)) {
        throw new StaleLockError(lockPath, meta);
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
  throw new Error(`Could not acquire lock at ${lockPath} after ${MAX_RETRIES * BACKOFF_MS}ms`);
}

function release(handle) {
  if (!handle) return;
  try { fs.rmSync(handle.lockPath, { recursive: true, force: true }); }
  catch (e) { /* best-effort */ }
}

function isStale(meta) {
  return (Date.now() - new Date(meta.created_at).getTime()) > STALE_MS;
}

function breakLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true });
}

module.exports = { acquire, release, isStale, breakLock, StaleLockError, STALE_MS, BACKOFF_MS };
