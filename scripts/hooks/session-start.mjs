#!/usr/bin/env node
import { isCaptureEnabled, normalizeAndAppend, detectHost } from './common.mjs';
if (!isCaptureEnabled()) process.exit(0);
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  await normalizeAndAppend('hook-session-start', input, detectHost());
} catch (e) {
  // A hook must never break the host session — swallow any capture failure
  // (malformed stdin, lock error, disk error) to a clean exit.
  console.error(`[deep-memory] session-start hook skipped: ${e && e.message}`);
}
process.exit(0);
