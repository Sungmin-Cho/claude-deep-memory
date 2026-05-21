// scripts/init.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execSync } = require('node:child_process');
const { preflight } = require('./lib/preflight');
const { writeJsonAtomic } = require('./lib/atomic-write');

function resolveMemoryRoot(raw) {
  const root = raw || process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');
  return root.replace(/^~/, os.homedir());
}

// ITEM-6-r4: accept cwd so callers in different working directories get the
// git config from the intended directory, not process.cwd().
function safeGit(cmd, cwd) {
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] };
    if (cwd) opts.cwd = cwd;
    return execSync(cmd, opts).toString().trim();
  } catch {
    return '';
  }
}

function projectId(cwd) {
  const remote = safeGit('git config --get remote.origin.url', cwd);
  const remoteHash = remote
    ? 'sha256:' + createHash('sha256').update(remote).digest('hex')
    : 'sha256:none';
  const rootHash = 'sha256:' + createHash('sha256').update(cwd).digest('hex');
  return 'proj_' + createHash('sha256').update(remoteHash + '|' + rootHash).digest('hex').slice(0, 12);
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

function defaultConfigYaml() {
  return `version: "0.1.0"
memory_root: ~/.deep-memory
privacy:
  default_scope: local
  allow_export: false
sources:
  - kind: review-recurring
    path: ".deep-review/recurring-findings.json"
    memory_type: failure-case
    producer: deep-review
    artifact_kind: recurring-findings
    supported_schema_versions: ["1.0"]
  - kind: evolve-insights
    path: ".deep-evolve/*/evolve-insights.json"
    memory_type: experiment-outcome
    producer: deep-evolve
    artifact_kind: evolve-insights
    supported_schema_versions: ["1.0"]
  - kind: work-receipt
    path: ".deep-work/*/session-receipt.json"
    memory_type: pattern
    producer: deep-work
    artifact_kind: session-receipt
    supported_schema_versions: ["1.0"]
  - kind: docs-scan
    path: ".deep-docs/last-scan.json"
    memory_type: coding-style
    producer: deep-docs
    artifact_kind: last-scan
    supported_schema_versions: ["1.0"]
  - kind: wiki-index
    path: "<wiki_root>/.wiki-meta/index.json"
    memory_type: architecture-decision
    producer: deep-wiki
    artifact_kind: wiki-index
    supported_schema_versions: ["1.0"]
distill:
  mode: hybrid
  llm:
    adapter: auto
    timeout_ms: 30000
    max_input_bytes: 4096
    on_failure: candidate
retrieve:
  top_n: 8
  diversity_per_type: 2
  scoring:
    w_project_sim: 0.2
    w_task_sim: 0.5
    w_evidence: 0.3
    w_stale_penalty: 0.1
audit:
  stale_grace_days: 90
  profile_max_age_days: 30
  high_redaction_chars: 200
suppressions_file: ~/.deep-memory/suppressions.yaml
`;
}

async function run({ memoryRoot, allowNetworkRoot = false } = {}) {
  const resolved = resolveMemoryRoot(memoryRoot);
  const pre = preflight(resolved, { allowNetworkRoot });
  if (!pre.ok) {
    throw new Error(`preflight failed:\n${pre.errors.join('\n')}`);
  }
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(pre.resolved, sub), { recursive: true });
  }
  const configPath = path.join(pre.resolved, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, defaultConfigYaml());
  }
  const cwd = process.cwd();
  const pid = projectId(cwd);
  // ITEM-6-r4: pass cwd to all safeGit calls inside run() so remote/head/branch
  // are read from the project directory, not from a potentially different process.cwd().
  const remote = safeGit('git config --get remote.origin.url', cwd);
  const profile = {
    project_id: pid,
    repo: {
      remote_url_hash: remote
        ? 'sha256:' + createHash('sha256').update(remote).digest('hex')
        : 'sha256:none',
      root_path_hash: 'sha256:' + createHash('sha256').update(cwd).digest('hex'),
      default_branch: safeGit('git symbolic-ref --short HEAD', cwd) || 'main',
      git_head: safeGit('git rev-parse HEAD', cwd),
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
  const localProfileDir = path.join(cwd, '.deep-memory');
  fs.mkdirSync(localProfileDir, { recursive: true });
  writeJsonAtomic(path.join(localProfileDir, 'project-profile.json'), profile);
  writeJsonAtomic(path.join(pre.resolved, 'projects', pid + '.json'), profile);

  return { memoryRoot: pre.resolved, projectId: pid, warnings: pre.warnings };
}

module.exports = { run, resolveMemoryRoot, projectId };

if (require.main === module) {
  const args = process.argv.slice(2);
  const memoryRoot = args.find((a) => !a.startsWith('--'));
  const allowNetworkRoot = args.includes('--allow-network-root');
  run({ memoryRoot, allowNetworkRoot })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
