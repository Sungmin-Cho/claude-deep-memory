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
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

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

  async function close(timeoutMs = 1000) {
    if (!child.killed) child.stdin.end();
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve();
        }, timeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
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
