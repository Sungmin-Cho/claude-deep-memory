'use strict';
// scripts/lib/audit-log.js
// ε.1 — envelope-conformant audit-log writer per spec §6.3.1 + R3-J + R4-E.
// Emits {at, id, kind, by, host, payload} entries ajv-validated against
// schemas/audit-log-entry.schema.json. Used by every mutation site
// (slash + MCP gate-violation + hook capture-toggle + init migration).
//
// R4-K dual-emission helper: writeMutationConsent() + writeMutationEntry()
// produce a paired (mutation-consent, kind-specific) pair within 1ms.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default || require('ajv-formats');

const schema = require('../../schemas/audit-log-entry.schema.json');
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// ULID-lite (sortable random ID — 26-char Crockford-base32-like). Not crypto-strong.
function ulidLike() {
  const t = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 16);
  return t + rand;
}

function auditLogPath(root) {
  const ym = new Date().toISOString().slice(0, 7);
  return path.join(root, 'audit-log', `${ym}.jsonl`);
}

/**
 * Write one envelope-conformant audit-log entry.
 * @param {string} root - $DEEP_MEMORY_ROOT
 * @param {object} entry - { kind, by, host, payload } — `at` + `id` auto-filled
 * @returns {object} the written entry (with at + id populated)
 * @throws if entry fails schema validation
 */
function writeEntry(root, entry) {
  const full = {
    at: entry.at || new Date().toISOString(),
    id: entry.id || ulidLike(),
    kind: entry.kind,
    by: entry.by,
    host: entry.host || process.env.DEEP_MEMORY_HOST || 'unknown',
    payload: entry.payload || {}
  };
  if (!validate(full)) {
    throw Object.assign(
      new Error(`audit-log entry schema violation: ${ajv.errorsText(validate.errors)}`),
      { code: 'AUDIT_LOG_SCHEMA_VIOLATION', errors: validate.errors }
    );
  }
  const p = auditLogPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(full) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return full;
}

/**
 * R4-K dual-emission helper. Writes BOTH the mutation-consent envelope AND
 * the kind-specific entry within 1ms (single Date.now read shared for `at`).
 * Use for every slash-mutation tool (forget, audit-*, export-cards).
 */
function writeMutationPair(root, { tool, args, by, host, kind, payload }) {
  const at = new Date().toISOString();
  const consent = writeEntry(root, {
    at, kind: 'mutation-consent',
    by: by || 'slash-direct',
    host,
    payload: { tool, args: args || {} }
  });
  const main = writeEntry(root, {
    at,  // shared timestamp — within 1ms of consent per R4-K assertion
    kind,
    by: by || 'slash-direct',
    host,
    payload
  });
  return { consent, main };
}

module.exports = { writeEntry, writeMutationPair, validate, ulidLike };
