#!/usr/bin/env node
// SessionEnd hook: same shape as pre-compact.mjs — capture + optional eager distill.
import { isCaptureEnabled, isEagerDistillEnabled, normalizeAndAppend, detectHost } from './common.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function main() {
  if (!isCaptureEnabled()) return;

  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    await normalizeAndAppend('hook-session-end', input, detectHost());

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
        // best-effort
      }
    }
  } catch (e) {
    // A hook must never break the host session — swallow any capture failure
    // (malformed stdin, lock error, disk error) to a clean exit.
    console.error(`[deep-memory] session-end hook skipped: ${e && e.message}`);
  }
}

main().finally(() => { process.exitCode = 0; });
