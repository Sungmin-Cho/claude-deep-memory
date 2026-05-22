#!/usr/bin/env node
'use strict';
// scripts/forget.js — IMPL-R1-D entry script for /deep-memory-forget skill.
// Demonstrates writeMutationPair wiring (mutation-consent + forget dual emission).
// Card body deletion delegated to existing cards/ directory operations.

const path = require('node:path');
const os = require('node:os');
const { writeMutationPair } = require('./lib/audit-log');

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

const memoryId = process.argv[2];
const reason = process.argv[3] || 'no reason provided';

if (!memoryId) {
  console.error('Usage: forget.js <memory_id> [reason]');
  process.exit(1);
}

try {
  const pair = writeMutationPair(DEEP_MEMORY_ROOT, {
    tool: 'forget',
    args: { memory_id: memoryId, reason },
    by: 'slash-direct',
    host: process.env.DEEP_MEMORY_HOST || 'claude-code',
    kind: 'forget',
    payload: { memory_id: memoryId, reason }
  });
  console.log(JSON.stringify({
    status: 'audit_logged',
    consent_id: pair.consent.id,
    forget_id: pair.main.id,
    note: 'card body deletion + index removal delegated to cards/ writer (v0.3.1)'
  }));
  process.exit(0);
} catch (e) {
  console.error(`forget.js failed: ${e.message}`);
  process.exit(2);
}
