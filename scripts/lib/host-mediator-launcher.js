'use strict';
const { spawn } = require('node:child_process');

function notify(message) {
  if (typeof process.send !== 'function') return;
  try { process.send(message); } catch { /* dispatcher owns timeout and cleanup */ }
}

let spec;
try {
  spec = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
} catch {
  notify({ type: 'mediator-error' });
  setInterval(() => {}, 1000);
  return;
}

let mediator;
try {
  mediator = spawn(spec.command, spec.args, {
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
} catch {
  notify({ type: 'mediator-error' });
  setInterval(() => {}, 1000);
  return;
}

process.stdin.on('data', (chunk) => {
  if (!mediator.stdin.destroyed) mediator.stdin.write(chunk);
});
process.stdin.on('end', () => {
  if (!mediator.stdin.destroyed) mediator.stdin.end();
});
process.stdin.on('error', () => {
  try { mediator.stdin.destroy(); } catch { /* owned tree cleanup follows */ }
});

mediator.stdout.on('data', (chunk) => notify({
  type: 'mediator-stdout', data: Buffer.from(chunk).toString('base64'),
}));
mediator.stderr.on('data', (chunk) => notify({
  type: 'mediator-stderr', data: Buffer.from(chunk).toString('base64'),
}));
mediator.once('error', () => notify({ type: 'mediator-error' }));
mediator.once('close', (code, signal) => notify({
  type: 'mediator-close', code, signal: signal || null,
}));

// Intentionally remain a live process-tree root after the mediator exits.
// The dispatcher validates the response and then terminates this entire owned
// group/job before it publishes success or failure.
setInterval(() => {}, 1000);
