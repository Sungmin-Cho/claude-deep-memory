'use strict';
const { spawnSync } = require('node:child_process');

function sanitizedGitEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)),
  );
}

function runGit(args, { cwd, env = process.env, spawn = spawnSync } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('git command requires an argument array');
  }

  try {
    const result = spawn('git', args, {
      cwd,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: sanitizedGitEnvironment(env),
    });
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

module.exports = { runGit };
