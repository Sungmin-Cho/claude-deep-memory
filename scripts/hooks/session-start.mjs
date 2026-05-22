#!/usr/bin/env node
import { isCaptureEnabled, normalizeAndAppend, detectHost } from './common.mjs';
if (!isCaptureEnabled()) process.exit(0);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
await normalizeAndAppend('hook-session-start', input, detectHost());
process.exit(0);
