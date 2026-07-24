#!/usr/bin/env node
// scripts/hooks/post-tool-use.mjs
// PR1-D: capture.enabled gate runs BEFORE any stdin read.
// PR2-A: invoked as `node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-use.mjs`
//        per manifest; no executable bit needed.

import { isCaptureEnabled, normalizeAndAppend, detectHost } from './common.mjs';

async function main() {
  if (!isCaptureEnabled()) {
    // R4-D: do NOT read stdin if capture disabled. Host treats exit 0 as ack.
    return;
  }

  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    await normalizeAndAppend('hook-post-tool-use', input, detectHost());
  } catch (e) {
    // A hook must never break the host session — swallow any capture failure
    // (malformed stdin, lock error, disk error) to a clean exit.
    console.error(`[deep-memory] post-tool-use hook skipped: ${e && e.message}`);
  }
}

main().finally(() => { process.exitCode = 0; });
