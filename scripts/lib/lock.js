// scripts/lib/lock.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

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

function identity(stat) {
  return stat ? {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  } : null;
}

function inspectLock(lockPath) {
  const metaPath = path.join(lockPath, 'metadata.json');
  try {
    const dirStat = fs.lstatSync(lockPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const bytes = fs.readFileSync(metaPath);
    const metaStat = fs.lstatSync(metaPath);
    if (metaStat.isSymbolicLink() || !metaStat.isFile()) return null;
    let meta = null;
    try { meta = JSON.parse(bytes.toString('utf8')); } catch { /* exact bytes still form a break claim */ }
    return {
      lockPath,
      metaPath,
      ownerToken: meta && typeof meta.owner_token === 'string' ? meta.owner_token : null,
      meta,
      metadataBytes: bytes.toString('base64'),
      directoryIdentity: identity(dirStat),
      metadataIdentity: identity(metaStat),
    };
  } catch {
    return null;
  }
}

function inspectEmptyLock(lockPath) {
  try {
    const dirStat = fs.lstatSync(lockPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    if (fs.readdirSync(lockPath).length !== 0) return null;
    return {
      kind: 'empty-lock',
      lockPath,
      directoryIdentity: identity(dirStat),
      observedMtimeMs: dirStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameClaim(left, right) {
  return Boolean(left && right
    && left.lockPath === right.lockPath
    && left.ownerToken === right.ownerToken
    && left.metadataBytes === right.metadataBytes
    && sameIdentity(left.directoryIdentity, right.directoryIdentity)
    && sameIdentity(left.metadataIdentity, right.metadataIdentity));
}

function sameEmptyClaim(left, right) {
  return Boolean(left && right
    && left.kind === 'empty-lock'
    && right.kind === 'empty-lock'
    && left.lockPath === right.lockPath
    && left.observedMtimeMs === right.observedMtimeMs
    && sameIdentity(left.directoryIdentity, right.directoryIdentity));
}

function emptyLockMeta(claim) {
  return {
    created_at: new Date(claim.observedMtimeMs).toISOString(),
    pid: null,
    host: null,
    operation: 'lock-bootstrap',
  };
}

async function acquire(lockPath, { operation = 'unknown' } = {}) {
  for (let i = 0; i < MAX_RETRIES; i += 1) {
    try {
      fs.mkdirSync(lockPath);
      const metaPath = path.join(lockPath, 'metadata.json');
      const ownerToken = randomUUID();
      try {
        fs.writeFileSync(metaPath, JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          created_at: new Date().toISOString(),
          operation,
          owner_token: ownerToken,
        }, null, 2), { flag: 'wx' });
      } catch (error) {
        try { fs.rmdirSync(lockPath); } catch { /* only our just-created empty directory is eligible */ }
        throw error;
      }
      const claim = inspectLock(lockPath);
      if (!claim || claim.ownerToken !== ownerToken) {
        throw new Error(`Could not establish lock ownership at ${lockPath}`);
      }
      return { lockPath, metaPath, ownerToken, claim };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const claim = inspectLock(lockPath);
      if (claim && claim.meta && isStale(claim.meta)) {
        throw new StaleLockError(lockPath, claim.meta);
      }
      const emptyClaim = claim ? null : inspectEmptyLock(lockPath);
      if (emptyClaim && isStale(emptyLockMeta(emptyClaim))) {
        throw new StaleLockError(lockPath, emptyLockMeta(emptyClaim));
      }
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }
  throw new Error(`Could not acquire lock at ${lockPath} after ${MAX_RETRIES * BACKOFF_MS}ms`);
}

function restoreMismatchedClaim(retiredPath, lockPath) {
  try {
    if (!fs.existsSync(lockPath)) fs.renameSync(retiredPath, lockPath);
  } catch { /* fail closed: never recursively remove an unverified directory */ }
}

function removeClaimedDirectory(lockPath, claim) {
  const observed = inspectLock(lockPath);
  if (!sameClaim(observed, claim)) return false;
  const retiredPath = `${lockPath}.retired-${randomUUID()}`;
  try { fs.renameSync(lockPath, retiredPath); }
  catch { return false; }
  const retiredClaim = { ...claim, lockPath: retiredPath, metaPath: path.join(retiredPath, 'metadata.json') };
  const retiredObserved = inspectLock(retiredPath);
  if (!sameClaim(retiredObserved, retiredClaim)) {
    restoreMismatchedClaim(retiredPath, lockPath);
    return false;
  }
  try {
    const entries = fs.readdirSync(retiredPath);
    if (entries.length !== 1 || entries[0] !== 'metadata.json') {
      restoreMismatchedClaim(retiredPath, lockPath);
      return false;
    }
    fs.unlinkSync(path.join(retiredPath, 'metadata.json'));
    fs.rmdirSync(retiredPath);
    return true;
  } catch {
    restoreMismatchedClaim(retiredPath, lockPath);
    return false;
  }
}

function removeEmptyClaimedDirectory(lockPath, claim) {
  const observed = inspectEmptyLock(lockPath);
  if (!sameEmptyClaim(observed, claim)) return false;
  const retiredPath = `${lockPath}.retired-${randomUUID()}`;
  try { fs.renameSync(lockPath, retiredPath); }
  catch { return false; }
  const retiredClaim = { ...claim, lockPath: retiredPath };
  const retiredObserved = inspectEmptyLock(retiredPath);
  if (!sameEmptyClaim(retiredObserved, retiredClaim)) {
    restoreMismatchedClaim(retiredPath, lockPath);
    return false;
  }
  try {
    fs.rmdirSync(retiredPath);
    return true;
  } catch {
    restoreMismatchedClaim(retiredPath, lockPath);
    return false;
  }
}

function release(handle) {
  if (!handle || !handle.claim || handle.ownerToken !== handle.claim.ownerToken) return false;
  return removeClaimedDirectory(handle.lockPath, handle.claim);
}

function isStale(meta) {
  return (Date.now() - new Date(meta.created_at).getTime()) > STALE_MS;
}

function breakLock(lockPath, observedClaim) {
  if (!observedClaim || observedClaim.lockPath !== lockPath) return false;
  return removeClaimedDirectory(lockPath, observedClaim);
}

function breakEmptyLock(lockPath, observedClaim) {
  if (!observedClaim || observedClaim.kind !== 'empty-lock'
      || observedClaim.lockPath !== lockPath) return false;
  if (!isStale(emptyLockMeta(observedClaim))) return false;
  return removeEmptyClaimedDirectory(lockPath, observedClaim);
}

module.exports = {
  acquire,
  release,
  inspectLock,
  inspectEmptyLock,
  isStale,
  breakLock,
  breakEmptyLock,
  StaleLockError,
  STALE_MS,
  BACKOFF_MS,
};
