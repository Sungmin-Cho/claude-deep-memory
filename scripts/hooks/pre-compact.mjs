#!/usr/bin/env node
// PreCompact hook: capture event + optionally enqueue eager distill child.
import { isCaptureEnabled, isEagerDistillEnabled, normalizeAndAppend, detectHost } from './common.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function main() {
  if (!isCaptureEnabled()) return;

  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    await normalizeAndAppend('hook-pre-compact', input, detectHost());

    // Eager distill (§3.2.1 fire-and-forget invariant — full invariants in β.9).
    // PR2-D: harvest.js --source enum is `siblings|all`; hook events route through
    // the dedicated --rebuild-from-events flag (the retroactive re-distill path).
    if (isEagerDistillEnabled()) {
      try {
        const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
          || process.env.PLUGIN_ROOT
          || process.cwd();
        const distillScript = path.join(pluginRoot, 'scripts', 'harvest.js');
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
  } catch (e) {
    // A hook must never break the host session — swallow any capture failure
    // (malformed stdin, lock error, disk error) to a clean exit.
    console.error(`[deep-memory] pre-compact hook skipped: ${e && e.message}`);
  }
}

main().finally(() => { process.exitCode = 0; });
