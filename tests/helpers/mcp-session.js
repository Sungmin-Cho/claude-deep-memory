'use strict';
const { spawn } = require('node:child_process');

function openMcpSession(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const pending = new Map();
  const protocolErrors = [];
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  let initializedWritten = false;
  let closePromise = null;

  function childClosed() {
    return child.exitCode !== null || child.signalCode !== null;
  }

  function rejectPending(error) {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  function waitForClose(timeoutMs) {
    if (childClosed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (closed) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.removeListener('close', onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      timer = setTimeout(() => finish(childClosed()), timeoutMs);
      child.once('close', onClose);
    });
  }

  function destroyProtocolStreams() {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (!stream || stream.destroyed) continue;
      try { stream.destroy(); } catch { /* best-effort after process termination */ }
    }
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        protocolErrors.push(new Error(`non-JSON MCP stdout: ${line.slice(0, 300)}`, { cause: error }));
        continue;
      }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`MCP error ${JSON.stringify(message.error)}`));
      else waiter.resolve(message);
    }
  });
  child.on('error', (error) => {
    rejectPending(error);
  });
  child.once('close', () => rejectPending(new Error('MCP child closed')));

  function write(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}, timeoutMs = options.timeoutMs || 5000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${stderr.slice(0, 800)}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params = {}) {
    if (method === 'notifications/initialized') initializedWritten = true;
    write({ jsonrpc: '2.0', method, params });
  }

  function close(timeoutMs = 1000) {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      rejectPending(new Error('MCP session closed'));
      if (!childClosed() && child.stdin && !child.stdin.destroyed) {
        try { child.stdin.end(); } catch { /* force termination below */ }
      }

      let closed = await waitForClose(timeoutMs);
      if (!closed) {
        try { child.kill('SIGKILL'); } catch { /* verified below */ }
        closed = await waitForClose(Math.max(timeoutMs, 250));
      }

      destroyProtocolStreams();
      if (!closed) {
        if (typeof child.unref === 'function') child.unref();
        throw new Error(`MCP child did not close within ${timeoutMs}ms`);
      }
    })();
    return closePromise;
  }

  return {
    child,
    request,
    notify,
    close,
    get initializedWritten() { return initializedWritten; },
    get stderr() { return stderr; },
    get protocolErrors() { return [...protocolErrors]; },
  };
}

module.exports = { openMcpSession };
