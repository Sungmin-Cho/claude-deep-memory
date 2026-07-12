'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const CONTRACT_VERSION = 'deep-memory-host-distill-v1';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const TERMINATION_GRACE_MS = 100;
const TREE_UTILITY_TIMEOUT_MS = 500;
const TREE_UTILITY_ATTEMPTS = 2;
const NEVER = new Promise(() => {});

function resolveMediatorLauncherPath(moduleDir = __dirname, io = fs) {
  const absoluteDir = path.resolve(moduleDir);
  const leaf = path.basename(absoluteDir).toLowerCase();
  const parentLeaf = path.basename(path.dirname(absoluteDir)).toLowerCase();
  let pluginRoot = null;
  if (leaf === 'lib' && parentLeaf === 'scripts') pluginRoot = path.resolve(absoluteDir, '..', '..');
  else if (leaf === 'dist') pluginRoot = path.resolve(absoluteDir, '..');
  const candidate = pluginRoot
    ? path.join(pluginRoot, 'scripts', 'lib', 'host-mediator-launcher.js')
    : null;
  try {
    if (candidate && io.statSync(candidate).isFile()) return candidate;
  } catch { /* typed unavailable below */ }
  throw dispatchError('host_dispatch_unavailable', 'owned mediator launcher is missing');
}

function resolveAgentContractPath(moduleDir = __dirname, io = fs) {
  const absoluteDir = path.resolve(moduleDir);
  const leaf = path.basename(absoluteDir).toLowerCase();
  const parentLeaf = path.basename(path.dirname(absoluteDir)).toLowerCase();
  let pluginRoot = null;
  if (leaf === 'lib' && parentLeaf === 'scripts') {
    pluginRoot = path.resolve(absoluteDir, '..', '..');
  } else if (leaf === 'dist') {
    pluginRoot = path.resolve(absoluteDir, '..');
  }
  const candidate = pluginRoot
    ? path.join(pluginRoot, 'agents', 'memory-distiller.md')
    : null;
  try {
    if (candidate && io.statSync(candidate).isFile()) return candidate;
  } catch { /* fall through to the typed unavailable error */ }
  throw dispatchError('host_dispatch_unavailable', 'authoritative memory-distiller contract is missing');
}

const AGENT_CONTRACT_PATH = resolveAgentContractPath();
const MEDIATOR_LAUNCHER_PATH = resolveMediatorLauncherPath();

function dispatchError(code, message) {
  return Object.assign(new Error(message), { code });
}

function processSpecFrom(value, env = process.env) {
  let candidate = value;
  if (candidate === undefined || candidate === null) {
    const encoded = env.DEEP_MEMORY_HOST_DISPATCH;
    if (!encoded) {
      throw dispatchError('host_dispatch_unavailable', 'host mediator process spec is not configured');
    }
    try {
      candidate = JSON.parse(encoded);
    } catch {
      throw dispatchError('host_dispatch_unavailable', 'host mediator process spec is invalid JSON');
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.command !== 'string' || !path.isAbsolute(candidate.command)
      || !Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === 'string')
      || Object.keys(candidate).some((key) => key !== 'command' && key !== 'args')) {
    throw dispatchError(
      'host_dispatch_unavailable',
      'host mediator requires JSON {command:absoluteExecutable,args:string[]}',
    );
  }
  return { command: candidate.command, args: [...candidate.args] };
}

function ownedMediatorProcessSpec(spec, { platform = process.platform } = {}) {
  // The launcher is used on every platform. POSIX makes it a process-group
  // leader; Windows taskkill /T keeps a live root PID for descendant proof.
  void platform;
  return {
    command: process.execPath,
    args: [
      MEDIATOR_LAUNCHER_PATH,
      Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url'),
    ],
  };
}

function agentContract() {
  const content = fs.readFileSync(AGENT_CONTRACT_PATH);
  return {
    path: AGENT_CONTRACT_PATH,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function directExitPromise(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  if (child.signalCode !== null && child.signalCode !== undefined) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
}

function stopProtocolIo(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    if (stream === child.stdout || stream === child.stderr) stream.removeAllListeners('data');
    if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalOwnedGroup(pid, signal, killImpl) {
  try {
    killImpl(-pid, signal);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function waitForUtility(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', () => finish(false));
    child.once('close', (code, signal) => {
      finish(code === 0 && !signal);
    });
    const timer = setTimeout(() => {
      try {
        if (typeof child.kill === 'function') child.kill('SIGKILL');
      } catch { /* a failed utility is handled by the bounded retry */ }
      if (typeof child.unref === 'function') child.unref();
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Stop protocol I/O and terminate the mediator tree that this module owns.
 * POSIX mediators are process-group leaders; Windows uses taskkill's native
 * descendant traversal. The promise resolves only after the direct child has
 * emitted close, so callers never publish a fallback while it can still run.
 */
async function terminateOwnedProcessTree(child, {
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  killImpl = process.kill.bind(process),
  graceMs = TERMINATION_GRACE_MS,
  utilityTimeoutMs = TREE_UTILITY_TIMEOUT_MS,
  utilityAttempts = TREE_UTILITY_ATTEMPTS,
  directExit = null,
} = {}) {
  stopProtocolIo(child);
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  const exited = directExit || directExitPromise(child);

  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows';
    const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    let treeTerminated = false;
    for (let attempt = 0; attempt < utilityAttempts && !treeTerminated; attempt += 1) {
      let killer;
      try {
        killer = spawnImpl(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env,
        });
      } catch {
        killer = null;
      }
      if (killer) treeTerminated = await waitForUtility(killer, utilityTimeoutMs);
    }
    if (!treeTerminated) await NEVER;
    await exited;
    return;
  }

  try {
    signalOwnedGroup(child.pid, 'SIGTERM', killImpl);
  } catch {
    await NEVER;
  }
  await delay(graceMs);
  try {
    signalOwnedGroup(child.pid, 'SIGKILL', killImpl);
  } catch {
    await NEVER;
  }
  await exited;
}

async function dispatchHostMediated({
  host,
  eventDraft,
  sourceExcerpt,
  processSpec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
  processLifecycle = {},
}) {
  if (host !== 'claude-code' && host !== 'codex') {
    throw dispatchError('host_dispatch_unavailable', 'host mediator supports only claude-code or codex');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw dispatchError('host_dispatch_unavailable', 'host mediator timeout must be a positive integer');
  }
  const spec = processSpecFrom(processSpec, env);
  const excerpt = String(sourceExcerpt);
  if (Buffer.byteLength(excerpt, 'utf8') > 4096) {
    throw dispatchError('host_dispatch_invalid_output', 'source excerpt exceeds the 4096-byte contract');
  }
  const contract = agentContract();
  const request = {
    contract_version: CONTRACT_VERSION,
    host,
    agent_contract_path: contract.path,
    agent_contract_sha256: contract.sha256,
    event_draft: eventDraft,
    source_excerpt: excerpt,
  };

  const responseText = await new Promise((resolve, reject) => {
    let child;
    const ownedSpec = ownedMediatorProcessSpec(spec);
    try {
      child = spawn(ownedSpec.command, ownedSpec.args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env,
      });
    } catch {
      reject(dispatchError('host_dispatch_failed', 'host mediator could not be started'));
      return;
    }

    let settled = false;
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const directExit = directExitPromise(child);
    const finishAfterTreeCompletion = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateOwnedProcessTree(child, { ...processLifecycle, env, directExit })
        .then(() => fn(value))
        .catch(() => reject(dispatchError(
          'host_dispatch_failed',
          'host mediator process tree could not be terminated',
        )));
    };
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const original = dispatchError(code, message);
      terminateOwnedProcessTree(child, { ...processLifecycle, env, directExit })
        .then(() => reject(original))
        .catch(() => reject(dispatchError(
          'host_dispatch_failed',
          'host mediator process tree could not be terminated',
        )));
    };
    const timer = setTimeout(
      () => fail('host_dispatch_timeout', 'host mediator exceeded its hard timeout'),
      timeoutMs,
    );

    child.once('error', () => fail('host_dispatch_failed', 'host mediator process failed'));
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'mediator-stdout') {
        const chunk = Buffer.from(String(message.data || ''), 'base64');
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          fail('host_dispatch_failed', 'host mediator stdout exceeded its bound');
          return;
        }
        stdoutChunks.push(chunk);
      } else if (message.type === 'mediator-stderr') {
        stderrBytes += Buffer.from(String(message.data || ''), 'base64').length;
        if (stderrBytes > maxStderrBytes) {
          fail('host_dispatch_failed', 'host mediator stderr exceeded its bound');
        }
      } else if (message.type === 'mediator-error') {
        fail('host_dispatch_failed', 'host mediator process failed');
      } else if (message.type === 'mediator-close') {
        if (message.code !== 0 || message.signal) {
          fail('host_dispatch_failed', 'host mediator exited unsuccessfully');
          return;
        }
        // IPC messages may split a UTF-8 code point at any byte boundary.
        // Preserve the raw bytes until the complete response has arrived, then
        // decode exactly once so multi-byte characters remain lossless.
        finishAfterTreeCompletion(
          resolve,
          Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
        );
      }
    });
    child.once('close', () => {
      if (!settled) fail('host_dispatch_failed', 'owned mediator launcher exited unexpectedly');
    });
    child.stdin.once('error', () => fail('host_dispatch_failed', 'host mediator stdin failed'));
    child.stdin.end(JSON.stringify(request));
  });

  let response;
  try {
    response = JSON.parse(responseText.trim());
  } catch {
    throw dispatchError('host_dispatch_invalid_output', 'host mediator stdout was not one JSON response');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw dispatchError('host_dispatch_invalid_output', 'host mediator response must be an object');
  }
  const keys = Object.keys(response).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'agent_contract_sha256', 'contract_version', 'output',
  ])) {
    throw dispatchError('host_dispatch_invalid_output', 'host mediator response envelope is invalid');
  }
  if (response.contract_version !== CONTRACT_VERSION
      || response.agent_contract_sha256 !== contract.sha256) {
    throw dispatchError('host_dispatch_contract_mismatch', 'host mediator contract identity did not match');
  }
  if (!response.output || typeof response.output !== 'object' || Array.isArray(response.output)) {
    throw dispatchError('host_dispatch_invalid_output', 'host mediator output must be an object');
  }
  return response.output;
}

module.exports = {
  dispatchHostMediated,
  processSpecFrom,
  agentContract,
  resolveAgentContractPath,
  resolveMediatorLauncherPath,
  ownedMediatorProcessSpec,
  CONTRACT_VERSION,
  AGENT_CONTRACT_PATH,
  MEDIATOR_LAUNCHER_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
  TERMINATION_GRACE_MS,
  TREE_UTILITY_TIMEOUT_MS,
  TREE_UTILITY_ATTEMPTS,
  terminateOwnedProcessTree,
  stopProtocolIo,
};
