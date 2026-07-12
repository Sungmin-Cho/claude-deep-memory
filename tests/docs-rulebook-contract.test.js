'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const validator = path.join(root, 'scripts', 'validate-docs-rulebooks.cjs');

const PLUGIN_ALIGNED = `# Documentation Maintenance Rules

## Version sources

Read the Claude version with \`node -e "console.log(require('./.claude-plugin/plugin.json').version)"\`.
Read the Codex version with \`node -e "console.log(require('./.codex-plugin/plugin.json').version)"\`.
The supported version sources are the Claude manifest, Codex manifest, and package.json.
package-lock.json and the MCP bundle are derived release checks, never extra version sources.

## Supported runtime and ordinary CI

Supported runtime and ordinary CI use Node 22 on Ubuntu, macOS, and Windows.
Every workflow run step uses the same pwsh shell. Ordinary CI is Node-only.

The official Codex Python validator is a maintainer-only local schema gate; it is not supported runtime or ordinary CI.

## legacy-oracle

Only a separately named Unix-only legacy-oracle job may use Python or pytest for byte-preserved legacy characterization.
`;

const SUITE_ALIGNED = `# Documentation Maintenance Rules

## Registry pin sources

The registry sources are \`.agents/plugins/marketplace.json\` and \`.claude-plugin/marketplace.json\`.
For every plugin release, both marketplace manifests carry identical release SHA pins.
Read marketplace SHA pins with Node-only tooling.
Keep \`.claude-plugin/suite-extensions.json\` aligned with the registry metadata.
This suite has no CHANGELOG and does not use a plugin version triple.

## Generated documentation

Only edit prose outside \`<!-- deep-suite:auto-generated:<id>:start -->\` marker regions.
Regenerate marker regions with \`npm run docs:write\`, then run \`npm run docs:check\` and \`npm run docs:sync\`.

## Supported runtime and ordinary CI

Supported runtime and ordinary CI use Node 22 on Ubuntu, macOS, and Windows.
Every workflow run step uses the same pwsh shell. Ordinary CI and release verification are Node-only.

The official Codex Python validator is a maintainer-only local schema gate; it is not supported runtime or ordinary CI.

## legacy-oracle

Only a separately named Unix-only legacy-oracle job may use Python or pytest for byte-preserved legacy characterization.
`;

function run(pluginText, suiteText, { omitPlugin = false, omitSuite = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-rulebook-'));
  const plugin = path.join(tmp, 'plugin.md');
  const suite = path.join(tmp, 'suite.md');
  if (!omitPlugin) fs.writeFileSync(plugin, pluginText, 'utf8');
  if (!omitSuite) fs.writeFileSync(suite, suiteText, 'utf8');
  const result = spawnSync(process.execPath, [validator, '--plugin-rule', plugin, '--suite-rule', suite], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return result;
}

function assertFailure(result, code) {
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, new RegExp(`"code":"${code}"`));
  for (const line of result.stderr.trim().split(/\r?\n/).filter(Boolean)) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 512, `diagnostic exceeds 512 bytes: ${line}`);
    assert.doesNotThrow(() => JSON.parse(line));
  }
}

test('role-aware plugin and suite rulebooks pass independently', () => {
  const result = run(PLUGIN_ALIGNED, SUITE_ALIGNED);
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /"code":"docs_rulebooks_valid"/);
});

test('missing rulebooks fail independently with typed diagnostics', () => {
  assertFailure(run(PLUGIN_ALIGNED, SUITE_ALIGNED, { omitPlugin: true }), 'rulebook_missing');
  assertFailure(run(PLUGIN_ALIGNED, SUITE_ALIGNED, { omitSuite: true }), 'rulebook_missing');
});

test('jq version reads are forbidden', () => {
  const outdated = PLUGIN_ALIGNED.replace(
    /node -e "console\.log\(require\('\.\/\.codex-plugin\/plugin\.json'\)\.version\)"/,
    'jq -r .version .codex-plugin/plugin.json',
  );
  assertFailure(run(outdated, SUITE_ALIGNED), 'rulebook_jq_forbidden');
});

test('Python or pytest cannot be a supported runtime or ordinary matrix CI', () => {
  const outdated = PLUGIN_ALIGNED.replace(
    'Supported runtime and ordinary CI use Node 22',
    'Supported runtime and ordinary CI use Node 22 plus Python and pytest',
  );
  assertFailure(run(outdated, SUITE_ALIGNED), 'rulebook_python_policy_invalid');
});

test('the complete Ubuntu macOS Windows Node 22 pwsh contract is mandatory', () => {
  for (const token of ['Ubuntu', 'macOS', 'Windows', 'Node 22', 'pwsh']) {
    const outdated = PLUGIN_ALIGNED.replace(token, 'omitted-platform');
    assertFailure(run(outdated, SUITE_ALIGNED), 'rulebook_ci_matrix_missing');
  }
});

test('Python outside the maintainer validator or separately named Unix legacy-oracle exception fails', () => {
  const outdated = PLUGIN_ALIGNED.replace(
    'Ordinary CI is Node-only.',
    'Ordinary CI is Node-only. Python may also be used for convenience.',
  );
  assertFailure(run(outdated, SUITE_ALIGNED), 'rulebook_python_policy_invalid');

  const notUnix = PLUGIN_ALIGNED.replace('Unix-only legacy-oracle', 'portable legacy-oracle');
  assertFailure(run(notUnix, SUITE_ALIGNED), 'rulebook_python_policy_invalid');

  const python3 = PLUGIN_ALIGNED.replace(
    'Ordinary CI is Node-only.',
    'Ordinary CI is Node-only. A python3 helper may read release versions.',
  );
  assertFailure(run(python3, SUITE_ALIGNED), 'rulebook_python_policy_invalid');

  const missingExceptionPolicy = PLUGIN_ALIGNED.replace(/\n## legacy-oracle[\s\S]*$/, '\n');
  assertFailure(run(missingExceptionPolicy, SUITE_ALIGNED), 'rulebook_python_policy_invalid');

  const widenedException = PLUGIN_ALIGNED.replace(
    'Only a separately named Unix-only legacy-oracle job may use Python or pytest for byte-preserved legacy characterization.',
    'The Unix-only legacy-oracle uses Python, and ordinary CI may also use Python.',
  );
  assertFailure(run(widenedException, SUITE_ALIGNED), 'rulebook_python_policy_invalid');
});

test('plugin and suite roles cannot be swapped', () => {
  assertFailure(run(SUITE_ALIGNED, PLUGIN_ALIGNED), 'rulebook_plugin_version_policy_missing');
});

test('suite role requires real pin, extension, and generated-document surfaces', () => {
  for (const token of [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'identical release SHA pins',
    'Read marketplace SHA pins with Node-only tooling',
    '.claude-plugin/suite-extensions.json',
    'deep-suite:auto-generated:<id>:start',
    'npm run docs:write',
    'npm run docs:sync',
  ]) {
    const outdated = SUITE_ALIGNED.replace(token, 'missing-suite-surface');
    assertFailure(run(PLUGIN_ALIGNED, outdated), 'rulebook_suite_policy_missing');
  }
});

test('suite pin reads also reject jq independently of plugin policy', () => {
  const outdated = SUITE_ALIGNED.replace(
    'Read marketplace SHA pins with Node-only tooling.',
    'Read marketplace SHA pins with jq.',
  );
  assertFailure(run(PLUGIN_ALIGNED, outdated), 'rulebook_jq_forbidden');
});

test('suite role rejects CHANGELOG and plugin version-triple contradictions', () => {
  const changelogContradiction = SUITE_ALIGNED.replace(
    'This suite has no CHANGELOG and does not use a plugin version triple.',
    'This suite has no CHANGELOG and does not use a plugin version triple. On every release add a CHANGELOG.md entry.',
  );
  assertFailure(run(PLUGIN_ALIGNED, changelogContradiction), 'rulebook_suite_policy_contradiction');

  const tripleContradiction = SUITE_ALIGNED.replace(
    'This suite has no CHANGELOG and does not use a plugin version triple.',
    "This suite has no CHANGELOG and does not use a plugin version triple. Synchronize .claude-plugin/plugin.json, .codex-plugin/plugin.json, and package.json versions.",
  );
  assertFailure(run(PLUGIN_ALIGNED, tripleContradiction), 'rulebook_suite_policy_contradiction');
});
