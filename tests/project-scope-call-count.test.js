'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openMcpSession } = require('./helpers/mcp-session');
const { writeValidProjectProfile } = require('./helpers/project-profile-fixtures');

const repoRoot = path.resolve(__dirname, '..');
const resolverPath = path.join(repoRoot, 'scripts/lib/project-resolver.js');
const artifact = path.join(repoRoot, 'tests/fixtures/sample-recurring-findings.json');

function fixture(t, prefix) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function observerPreload(t) {
  const root = fixture(t, 'dm-scope-observer Ω ');
  const preload = path.join(root, 'observer.cjs');
  fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs');
const resolver = require(${JSON.stringify(resolverPath)});
resolver.setProjectScopeObserver((workspaceRoot) => {
  fs.appendFileSync(process.env.DM_SCOPE_TRACE_FILE, JSON.stringify({ workspaceRoot }) + '\\n');
});
`);
  return preload;
}

function tracedEnv(preload, trace, extra = {}) {
  return {
    ...process.env,
    ...extra,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim(),
    DM_SCOPE_TRACE_FILE: trace,
  };
}

function traceEntries(trace) {
  if (!fs.existsSync(trace)) return [];
  return fs.readFileSync(trace, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function assertExactlyOneResolution(trace, projectRoot, label) {
  const entries = traceEntries(trace);
  assert.equal(entries.length, 1, `${label}: ${JSON.stringify(entries)}`);
  assert.equal(fs.realpathSync.native(entries[0].workspaceRoot), fs.realpathSync.native(projectRoot), label);
}

test('MCP resolves project scope once and reuses it across tools and resources', async (t) => {
  const preload = observerPreload(t);
  const trace = path.join(path.dirname(preload), 'mcp.jsonl');
  const projectRoot = fixture(t, 'dm-scope-mcp-project-');
  const memoryRoot = fixture(t, 'dm-scope-mcp-memory-');
  writeValidProjectProfile(projectRoot);
  const session = openMcpSession(process.execPath, [path.join(repoRoot, 'dist/mcp-server.cjs')], {
    cwd: repoRoot,
    env: tracedEnv(preload, trace, {
      PLUGIN_ROOT: repoRoot,
      PROJECT_CWD: projectRoot,
      DEEP_MEMORY_ROOT: memoryRoot,
    }),
  });
  t.after(() => session.close());
  await session.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scope-count', version: '1' },
  });
  session.notify('notifications/initialized');
  await session.request('tools/list');
  const resources = await session.request('resources/list');
  for (const resource of resources.result.resources) {
    await session.request('resources/read', { uri: resource.uri });
  }
  assertExactlyOneResolution(trace, projectRoot, 'MCP');
});

test('brief, every hook, and all harvest CLI shapes resolve project scope once', (t) => {
  const preload = observerPreload(t);
  const projectRoot = fixture(t, 'dm-scope-cli-project-');
  const profile = writeValidProjectProfile(projectRoot);

  const invocations = [];
  invocations.push({
    label: 'brief',
    script: path.join(repoRoot, 'scripts/brief.js'),
    args: ['scope count task'],
    input: null,
  });
  for (const hook of [
    'session-start.mjs', 'user-prompt-submit.mjs', 'post-tool-use.mjs',
    'post-tool-failure.mjs', 'pre-compact.mjs', 'session-end.mjs',
  ]) {
    invocations.push({
      label: `hook:${hook}`,
      script: path.join(repoRoot, 'scripts/hooks', hook),
      args: [],
      input: JSON.stringify({ session_id: `scope-${hook}`, tool_name: 'Edit', tool_input: {}, tool_output: 'ok' }),
    });
  }
  for (const [label, args] of [
    ['harvest', [artifact, '--kind', 'review-recurring']],
    ['harvest-project', [artifact, '--kind', 'review-recurring', '--project', profile.project_id]],
    ['rebuild', ['--rebuild-from-events']],
    ['rebuild-project', ['--rebuild-from-events', '--project', profile.project_id]],
  ]) {
    invocations.push({ label, script: path.join(repoRoot, 'scripts/harvest.js'), args, input: null });
  }

  for (const [index, invocation] of invocations.entries()) {
    const memoryRoot = fixture(t, `dm-scope-cli-memory-${index}-`);
    fs.writeFileSync(path.join(memoryRoot, 'config.yaml'), 'capture:\n  enabled: true\n  eager_distill: false\n');
    const trace = path.join(path.dirname(preload), `${index}.jsonl`);
    const result = spawnSync(process.execPath, [invocation.script, ...invocation.args], {
      cwd: projectRoot,
      env: tracedEnv(preload, trace, {
        PROJECT_CWD: projectRoot,
        DEEP_MEMORY_ROOT: memoryRoot,
      }),
      input: invocation.input,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(result.status, 0, `${invocation.label}: ${result.stderr}`);
    assertExactlyOneResolution(trace, projectRoot, invocation.label);
  }
});
