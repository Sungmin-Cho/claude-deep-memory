'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { harvestArtifact } = require('../scripts/harvest');
const { redactObject } = require('../scripts/lib/redact');
const { truncateUtf8 } = require('../scripts/lib/utf8-truncate');
const { terminateOwnedProcessTree } = require('../scripts/lib/host-mediated-dispatch');

const root = path.resolve(__dirname, '..');
const harvestScript = path.join(root, 'scripts', 'harvest.js');
const initScript = path.join(root, 'scripts', 'init.js');
const mediator = path.join(root, 'tests', 'fixtures', 'host-mediated-distiller.js');
const agentPath = path.join(root, 'agents', 'memory-distiller.md');
const baseArtifact = JSON.parse(fs.readFileSync(
  path.join(root, 'tests', 'fixtures', 'sample-recurring-findings.json'), 'utf8'));

function tmp(t, prefix) {
  const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function writeLargeArtifact(file) {
  const artifact = structuredClone(baseArtifact);
  artifact.envelope.run_id = `01j_host_${Date.now()}`;
  artifact.payload = {
    secret_context: `token=abcdefghijklmnop ${'한🧠e\u0301'.repeat(1600)}`,
    ...artifact.payload,
  };
  fs.writeFileSync(file, JSON.stringify(artifact));
  return artifact;
}

function cardFiles(memoryRoot) {
  const cards = path.join(memoryRoot, 'cards');
  return fs.existsSync(cards)
    ? fs.readdirSync(cards, { recursive: true })
      .filter((name) => String(name).endsWith('.json'))
      .map((name) => path.join(cards, name))
    : [];
}

test('production CLI runs redacted bounded Step B through a shell-free host process and persists refinement', (t) => {
  const project = tmp(t, 'dm-host-project-');
  const memoryRoot = tmp(t, 'dm-host-memory-');
  const artifactPath = path.join(project, 'large artifact.json');
  const observedPath = path.join(project, 'observed.json');
  const artifact = writeLargeArtifact(artifactPath);

  const initialized = spawnSync(process.execPath, [initScript, memoryRoot], {
    cwd: project,
    env: { ...process.env, DEEP_MEMORY_ROOT: memoryRoot, PROJECT_CWD: project },
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(project, '.deep-memory/project-profile.json'), 'utf8'));
  const processSpec = { command: process.execPath, args: [mediator] };
  const result = spawnSync(process.execPath, [
    harvestScript, artifactPath, '--kind', 'review-recurring', '--project', profile.project_id,
  ], {
    cwd: project,
    env: {
      ...process.env,
      PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_ROOT: '',
      PROJECT_CWD: project,
      DEEP_MEMORY_ROOT: memoryRoot,
      DEEP_MEMORY_HOST_DISPATCH: JSON.stringify(processSpec),
      HOST_MEDIATED_OBSERVED: observedPath,
    },
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /^Harvest: 1 card\(s\) from review-recurring/m);
  assert.doesNotMatch(result.stdout, /deep-memory-host-distill-v1|agent_contract_sha256|claim_refined|Host-mediated refinement/);

  const observed = JSON.parse(fs.readFileSync(observedPath, 'utf8'));
  const redacted = JSON.stringify(redactObject(artifact.payload));
  assert.equal(observed.contract_version, 'deep-memory-host-distill-v1');
  assert.equal(observed.host, 'codex');
  assert.equal(observed.agent_contract_path, agentPath);
  assert.equal(observed.agent_contract_sha256,
    createHash('sha256').update(fs.readFileSync(agentPath)).digest('hex'));
  assert.equal(observed.source_excerpt, truncateUtf8(redacted, 4096));
  assert.ok(Buffer.byteLength(observed.source_excerpt, 'utf8') <= 4096);
  assert.doesNotMatch(observed.source_excerpt, /abcdefghijklmnop/);
  assert.match(observed.source_excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(observed.event_draft), /abcdefghijklmnop/);

  const files = cardFiles(memoryRoot);
  assert.equal(files.length, 1);
  const card = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  assert.equal(card.payload.claim, 'Host-mediated refinement executed');
  assert.ok(card.payload.recommended_action.includes('Keep the authoritative contract hash attached'));
  const summary = JSON.parse(fs.readFileSync(path.join(project, '.deep-memory/latest-harvest.json'), 'utf8'));
  assert.equal(summary.cards_count, 1);
  assert.equal(summary.warnings.some((warning) => String(warning).startsWith('host_dispatch_')), false);
});

async function runFallback(
  t,
  label,
  processSpec,
  expectedCode,
  timeoutMs = 500,
  bridgeTimeoutMs = 30000,
  overrides = {},
) {
  const memoryRoot = tmp(t, `dm-host-${label}-`);
  const artifactPath = path.join(memoryRoot, `${label}.json`);
  writeLargeArtifact(artifactPath);
  const previous = process.env.DEEP_MEMORY_HOST_DISPATCH;
  delete process.env.DEEP_MEMORY_HOST_DISPATCH;
  try {
    const cards = await harvestArtifact({
      artifactPath,
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      llmAdapter: 'claude-agent',
      llmHostProcessSpec: processSpec,
      llmHostDispatchTimeoutMs: timeoutMs,
      llmTimeoutMs: bridgeTimeoutMs,
      ...overrides,
    });
    assert.equal(cards.length, 1);
    assert.notEqual(cards[0].payload.claim, 'Host-mediated refinement executed');
    assert.equal(cards[0].payload.confidence, 0.5);
    const warning = cards.warnings.find((item) => String(item).startsWith(`${expectedCode}:`));
    assert.ok(warning, `${label}: ${JSON.stringify(cards.warnings)}`);
    assert.ok(Buffer.byteLength(warning, 'utf8') <= 512, warning);
    assert.equal(cardFiles(memoryRoot).length, 1, 'candidate fallback must be persisted');
  } finally {
    if (previous === undefined) delete process.env.DEEP_MEMORY_HOST_DISPATCH;
    else process.env.DEEP_MEMORY_HOST_DISPATCH = previous;
  }
}

test('absent and invalid mediator configurations persist typed candidate fallbacks', async (t) => {
  await runFallback(t, 'absent', null, 'host_dispatch_unavailable');
  await runFallback(t, 'invalid', { command: 'node', args: [] }, 'host_dispatch_unavailable');
});

test('spawn failure and timeout persist typed candidate fallbacks', async (t) => {
  await runFallback(t, 'spawn', { command: path.join(tmp(t, 'dm-missing-exe-'), 'missing'), args: [] },
    'host_dispatch_failed');
  await runFallback(t, 'timeout', { command: process.execPath, args: [mediator, '--mode=timeout'] },
    'host_dispatch_timeout', 25);
});

test('bridge timeout cannot abandon a live mediator child', async (t) => {
  const markerRoot = tmp(t, 'dm-host-late-marker-');
  const marker = path.join(markerRoot, 'late.txt');
  const previous = process.env.HOST_MEDIATED_LATE_MARKER;
  process.env.HOST_MEDIATED_LATE_MARKER = marker;
  try {
    await runFallback(
      t,
      'bridge-timeout',
      { command: process.execPath, args: [mediator, '--mode=timeout'] },
      'host_dispatch_timeout',
      500,
      25,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(fs.existsSync(marker), false, 'timed-out mediator child must be terminated');
  } finally {
    if (previous === undefined) delete process.env.HOST_MEDIATED_LATE_MARKER;
    else process.env.HOST_MEDIATED_LATE_MARKER = previous;
  }
});

async function assertNoLateActivity(t, {
  label,
  mode,
  timeoutMs,
  bridgeTimeoutMs = 30000,
  overrides = {},
  expectedCode = 'host_dispatch_timeout',
}) {
  const markerRoot = tmp(t, `dm-host-${label}-marker-`);
  const marker = path.join(markerRoot, 'late.txt');
  const previous = process.env.HOST_MEDIATED_LATE_MARKER;
  process.env.HOST_MEDIATED_LATE_MARKER = marker;
  try {
    await runFallback(
      t,
      label,
      { command: process.execPath, args: [mediator, `--mode=${mode}`] },
      expectedCode,
      timeoutMs,
      bridgeTimeoutMs,
      overrides,
    );
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(fs.existsSync(marker), false, `${label}: mediator tree produced late activity`);
  } finally {
    if (previous === undefined) delete process.env.HOST_MEDIATED_LATE_MARKER;
    else process.env.HOST_MEDIATED_LATE_MARKER = previous;
  }
}

test('hard timeout kills a SIGTERM-ignoring direct mediator before fallback resolves', async (t) => {
  await assertNoLateActivity(t, {
    label: 'signal-ignore', mode: 'signal-ignore', timeoutMs: 150,
  });
});

test('hard timeout kills mediator descendants before fallback resolves', async (t) => {
  await assertNoLateActivity(t, {
    label: 'descendant', mode: 'descendant', timeoutMs: 300,
  });
});

test('stdout and stderr bound failures also terminate the owned mediator tree', async (t) => {
  await assertNoLateActivity(t, {
    label: 'stdout-overflow', mode: 'stdout-overflow-ignore', timeoutMs: 2000,
    expectedCode: 'host_dispatch_failed',
  });
  await assertNoLateActivity(t, {
    label: 'stderr-overflow', mode: 'stderr-overflow-ignore', timeoutMs: 2000,
    expectedCode: 'host_dispatch_failed',
  });
});

test('legacy live flags cannot bypass dispatcher lifetime or host_dispatch taxonomy', async (t) => {
  await assertNoLateActivity(t, {
    label: 'live-agent', mode: 'signal-ignore', timeoutMs: 500, bridgeTimeoutMs: 150,
    overrides: { llmAdapter: 'claude-agent', liveAgent: true },
  });
  await assertNoLateActivity(t, {
    label: 'live-codex', mode: 'signal-ignore', timeoutMs: 500, bridgeTimeoutMs: 150,
    overrides: { llmAdapter: 'codex-bash', liveCodex: true },
  });
});

test('Windows lifecycle seam invokes shell-free taskkill tree force and waits for child close', async () => {
  assert.equal(typeof terminateOwnedProcessTree, 'function');
  const events = [];
  const child = new (require('node:events').EventEmitter)();
  child.pid = 4242;
  const spawnImpl = (command, args, options) => {
    events.push({ command, args, options });
    const killer = new (require('node:events').EventEmitter)();
    killer.pid = 4343;
    setImmediate(() => {
      killer.emit('close', 0, null);
      child.emit('close', null, 'SIGKILL');
    });
    return killer;
  };
  await terminateOwnedProcessTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawnImpl,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].command, path.win32.join('C:\\Windows', 'System32', 'taskkill.exe'));
  assert.deepEqual(events[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(events[0].options.shell, false);
  assert.deepEqual(events[0].options.stdio, ['ignore', 'ignore', 'ignore']);
});

test('Windows lifecycle bounds a hung taskkill, retries, and then verifies direct-child close', async () => {
  const child = new (require('node:events').EventEmitter)();
  child.pid = 5252;
  const killers = [];
  const spawnImpl = () => {
    const killer = new (require('node:events').EventEmitter)();
    killer.pid = 5353 + killers.length;
    killer.kill = () => {
      killer.killed = true;
      setImmediate(() => killer.emit('close', null, 'SIGKILL'));
      return true;
    };
    killer.unref = () => { killer.unrefed = true; };
    killers.push(killer);
    if (killers.length === 2) {
      setImmediate(() => {
        killer.emit('close', 0, null);
        child.emit('close', null, 'SIGKILL');
      });
    }
    return killer;
  };
  await terminateOwnedProcessTree(child, {
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawnImpl, utilityTimeoutMs: 20,
  });
  assert.equal(killers.length, 2);
  assert.equal(killers[0].killed, true);
  assert.equal(killers[0].unrefed, true);
});

test('unverified Windows tree termination and unverified POSIX close remain fail-closed', async () => {
  const windowsChild = new (require('node:events').EventEmitter)();
  windowsChild.pid = 6262;
  const failedTaskkill = () => {
    const killer = new (require('node:events').EventEmitter)();
    killer.pid = 6363;
    setImmediate(() => killer.emit('close', 1, null));
    return killer;
  };
  const windowsResult = terminateOwnedProcessTree(windowsChild, {
    platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawnImpl: failedTaskkill,
    utilityTimeoutMs: 20,
  }).then(() => 'resolved');
  assert.equal(await Promise.race([
    windowsResult,
    new Promise((resolve) => setTimeout(() => resolve('pending'), 80)),
  ]), 'pending');

  const posixChild = new (require('node:events').EventEmitter)();
  posixChild.pid = 7272;
  const signals = [];
  const posixResult = terminateOwnedProcessTree(posixChild, {
    platform: 'linux', killImpl: (pid, signal) => { signals.push([pid, signal]); }, graceMs: 10,
  }).then(() => 'resolved');
  assert.equal(await Promise.race([
    posixResult,
    new Promise((resolve) => setTimeout(() => resolve('pending'), 80)),
  ]), 'pending');
  assert.deepEqual(signals, [[-7272, 'SIGTERM'], [-7272, 'SIGKILL']]);
});

test('termination releases every protocol stream before signaling the owned tree', async () => {
  const EventEmitter = require('node:events');
  const stream = () => {
    const value = new EventEmitter();
    value.destroyed = false;
    value.destroy = () => { value.destroyed = true; };
    value.on('data', () => {});
    return value;
  };
  const child = new EventEmitter();
  child.pid = 8282;
  child.stdin = stream();
  child.stdout = stream();
  child.stderr = stream();
  await terminateOwnedProcessTree(child, {
    platform: 'linux',
    graceMs: 5,
    killImpl: (_pid, signal) => {
      if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, signal));
    },
  });
  for (const protocolStream of [child.stdin, child.stdout, child.stderr]) {
    assert.equal(protocolStream.destroyed, true);
  }
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('contract mismatch, malformed stdout, and schema-invalid output persist typed fallbacks', async (t) => {
  await runFallback(t, 'mismatch', { command: process.execPath, args: [mediator, '--mode=contract-mismatch'] },
    'host_dispatch_contract_mismatch');
  await runFallback(t, 'malformed', { command: process.execPath, args: [mediator, '--mode=malformed'] },
    'host_dispatch_invalid_output');
  await runFallback(t, 'schema', { command: process.execPath, args: [mediator, '--mode=schema-invalid'] },
    'host_dispatch_invalid_output');
});
