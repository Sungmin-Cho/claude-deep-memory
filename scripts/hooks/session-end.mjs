#!/usr/bin/env node
// SessionEnd hook: same shape as pre-compact.mjs — capture + optional eager distill.
import { isCaptureEnabled, isEagerDistillEnabled, normalizeAndAppend, detectHost } from './common.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!isCaptureEnabled()) process.exit(0);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
await normalizeAndAppend('hook-session-end', input, detectHost());

if (isEagerDistillEnabled()) {
  try {
    const distillScript = fileURLToPath(new URL('../harvest.js', import.meta.url));
    const sessionId = input.session_id || 'unknown';
    const child = spawn('node', [distillScript, '--rebuild-from-events', '--session', sessionId], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch {
    // best-effort
  }
}

process.exit(0);
