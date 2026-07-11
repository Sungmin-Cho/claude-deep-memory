'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function canonicalPhysicalPath(value, io = fs) {
  if (!value) return null;
  try { return io.realpathSync.native(path.resolve(value)); }
  catch { return null; }
}

function samePath(a, b, { io = fs, platform = process.platform } = {}) {
  const left = canonicalPhysicalPath(a, io);
  const right = canonicalPhysicalPath(b, io);
  if (!left || !right) return false;
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function resolveRuntimeRoots({
  env = process.env,
  cwd = process.cwd(),
  entryDir,
  io = fs,
  platform = process.platform,
} = {}) {
  if (!entryDir) throw new TypeError('resolveRuntimeRoots requires entryDir');
  const inferredPluginRoot = path.dirname(path.resolve(entryDir));
  const pluginCandidate = env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || inferredPluginRoot;
  const pluginRoot = canonicalPhysicalPath(pluginCandidate, io);
  if (!pluginRoot) {
    throw Object.assign(new Error('Plugin root is not physically resolvable'), {
      code: 'PLUGIN_ROOT_UNRESOLVED',
    });
  }
  const workspaceCandidate = env.PROJECT_CWD || env.INIT_CWD || cwd || null;
  const workspacePhysical = canonicalPhysicalPath(workspaceCandidate, io);
  const workspaceRoot = workspacePhysical && !samePath(workspacePhysical, pluginRoot, { io, platform })
    ? workspacePhysical
    : null;
  const memoryRoot = path.resolve(env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory'));
  return { pluginRoot, workspaceRoot, memoryRoot };
}

module.exports = { resolveRuntimeRoots, samePath, canonicalPhysicalPath };
