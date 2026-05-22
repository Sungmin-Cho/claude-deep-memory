#!/usr/bin/env node
// PreCompact hook: capture event + optionally enqueue eager distill child.
import { isCaptureEnabled, isEagerDistillEnabled, normalizeAndAppend, detectHost } from './common.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!isCaptureEnabled()) process.exit(0);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
await normalizeAndAppend('hook-pre-compact', input, detectHost());

// Eager distill (§3.2.1 fire-and-forget invariant — full invariants in β.9).
// PR2-D: harvest.js --source enum is `siblings|all`; hook events route through
// the dedicated --rebuild-from-events flag (the retroactive re-distill path).
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
    // best-effort — never block hook on distill spawn errors
  }
}

process.exit(0);
