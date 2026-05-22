#!/usr/bin/env node
// scripts/hooks/post-tool-use.mjs
// PR1-D: capture.enabled gate runs BEFORE any stdin read.
// PR2-A: invoked as `node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/post-tool-use.mjs`
//        per manifest; no executable bit needed.

import { isCaptureEnabled, normalizeAndAppend, detectHost } from './common.mjs';

if (!isCaptureEnabled()) {
  // R4-D: do NOT read stdin if capture disabled. Host treats exit 0 as ack.
  process.exit(0);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
await normalizeAndAppend('hook-post-tool-use', input, detectHost());
process.exit(0);
