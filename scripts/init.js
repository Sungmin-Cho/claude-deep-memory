// scripts/init.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { preflight } = require('./lib/preflight');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { runGit } = require('./lib/git-command');
const { setCaptureEnabled, ensureConfig } = require('./lib/capture-toggle');
const { deriveProjectId } = require('./lib/project-resolver');
const { validateProjectProfile } = require('./lib/project-profile-validator');
const { expandHomePath } = require('./lib/path-utils');

function resolveMemoryRoot(raw) {
  const root = raw || process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');
  return expandHomePath(root);
}

// ITEM-6-r4: accept cwd so callers in different working directories get the
// git config from the intended directory, not process.cwd().
function safeGit(args, cwd, gitProcess = runGit) {
  try {
    const result = gitProcess(args, { cwd });
    return typeof result === 'string' ? result.trim() : '';
  } catch {
    return '';
  }
}

function projectId(cwd) {
  return deriveProjectId(cwd);
}

function detectLanguages(cwd) {
  const languages = new Set();
  let entries = [];
  try { entries = fs.readdirSync(cwd); } catch { return []; }
  for (const entry of entries) {
    if (entry === 'package.json') languages.add('javascript');
    if (entry === 'requirements.txt' || entry === 'pyproject.toml') languages.add('python');
    if (entry === 'go.mod') languages.add('go');
    if (entry === 'Cargo.toml') languages.add('rust');
    if (/\.sh$/.test(entry)) languages.add('bash');
  }
  return [...languages];
}

async function run({ memoryRoot, allowNetworkRoot = false, capture } = {}) {
  const resolved = resolveMemoryRoot(memoryRoot);
  const pre = preflight(resolved, { allowNetworkRoot });
  if (!pre.ok) {
    throw new Error(`preflight failed:\n${pre.errors.join('\n')}`);
  }
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(pre.resolved, sub), { recursive: true });
  }
  // Create config.yaml (if absent) under the capture lock so a plain init can
  // never race-overwrite a concurrent --enable-capture's config (R6 N9).
  ensureConfig(pre.resolved);
  const cwd = fs.realpathSync.native(process.cwd());
  const pid = projectId(cwd);
  // ITEM-6-r4: pass cwd to all safeGit calls inside run() so remote/head/branch
  // are read from the project directory, not from a potentially different process.cwd().
  const remote = safeGit(['config', '--get', 'remote.origin.url'], cwd);
  const profile = {
    project_id: pid,
    repo: {
      remote_url_hash: remote
        ? 'sha256:' + createHash('sha256').update(remote).digest('hex')
        : 'sha256:' + createHash('sha256').update('no-remote').digest('hex'),
      root_path_hash: 'sha256:' + createHash('sha256').update(cwd).digest('hex'),
      default_branch: safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || 'main',
      git_head: safeGit(['rev-parse', 'HEAD'], cwd),
    },
    signature: {
      languages: detectLanguages(cwd),
      runtimes: ['node'],
      topology: 'unknown',
      test_frameworks: [],
      package_managers: [],
      agent_runtime: [],
    },
    suite: { installed_plugins: [] },
    privacy: { scope: 'local', allow_export: false },
    source_mtimes: {},
    generated_at: new Date().toISOString(),
  };
  const validation = validateProjectProfile(profile);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.reason), { code: validation.reason });
  }
  const localProfileDir = path.join(cwd, '.deep-memory');
  fs.mkdirSync(localProfileDir, { recursive: true });
  writeJsonAtomic(path.join(localProfileDir, 'project-profile.json'), profile);
  writeJsonAtomic(path.join(pre.resolved, 'projects', pid + '.json'), profile);

  const result = { memoryRoot: pre.resolved, projectId: pid, warnings: pre.warnings };
  // config.yaml exists by now (created above), so the toggle only edits it.
  if (capture !== undefined) {
    result.capture = setCaptureEnabled(pre.resolved, capture, {
      by: 'cli-flag',
      method: 'cli-flag',
      host: process.env.DEEP_MEMORY_HOST || 'unknown',
    });
    // Surface an audit-write warning (non-fatal) up to the top-level result.
    if (result.capture.warnings) {
      result.warnings = [...(result.warnings || []), ...result.capture.warnings];
    }
  }
  return result;
}

module.exports = { run, resolveMemoryRoot, projectId, safeGit };

if (require.main === module) {
  const args = process.argv.slice(2);

  // Reject unknown --flags so a typo (e.g. --enable-captur) fails loudly
  // instead of silently leaving capture unchanged.
  const KNOWN_FLAGS = ['--allow-network-root', '--enable-capture', '--disable-capture'];
  // Any leading-dash token (single or double) that isn't a known flag is an
  // unknown option — a bare `-x` must not slip through as a positional.
  const unknown = args.find((a) => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknown) {
    console.error(`unknown option: ${unknown}`);
    process.exit(1);
  }
  // At most one positional (the memory_root).
  const positionals = args.filter((a) => !a.startsWith('-'));
  if (positionals.length > 1) {
    console.error(`expected at most one memory_root argument, got ${positionals.length}: ${positionals.join(' ')}`);
    process.exit(1);
  }
  const memoryRoot = positionals[0];
  const allowNetworkRoot = args.includes('--allow-network-root');
  const enable = args.includes('--enable-capture');
  const disable = args.includes('--disable-capture');
  if (enable && disable) {
    console.error('--enable-capture and --disable-capture are mutually exclusive');
    process.exit(1);
  }
  const capture = enable ? true : disable ? false : undefined;
  run({ memoryRoot, allowNetworkRoot, capture })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
