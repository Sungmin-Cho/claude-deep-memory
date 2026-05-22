'use strict';
// δ.20 R4-E + R4-K — audit-log writer conformance test.
// Drives each conceptual writer through one realistic action; ajv-validates
// every emitted line against schemas/audit-log-entry.schema.json; asserts
// dual emission (mutation-consent + kind-specific) for slash mutations.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default || require('ajv-formats');
const { writeEntry, writeMutationPair } = require('../scripts/lib/audit-log');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audit-log-entry.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-audit-conform-'));
}

function readAuditLog(root) {
  const ym = new Date().toISOString().slice(0, 7);
  const p = path.join(root, 'audit-log', `${ym}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('R4-E: writeEntry emits envelope-conformant entry (capture-toggle)', () => {
  const root = mkTmpRoot();
  writeEntry(root, {
    kind: 'capture-toggle', by: 'slash-direct', host: 'claude-code',
    payload: { from: false, to: true, method: 'prompted' }
  });
  const lines = readAuditLog(root);
  assert.strictEqual(lines.length, 1);
  assert.ok(validate(lines[0]), JSON.stringify(validate.errors));
});

test('R4-E: 7 kind variants from per-writer simulation all ajv-validate', () => {
  const root = mkTmpRoot();
  // Each writer drives one realistic action; we simulate each by calling
  // writeEntry/writeMutationPair with representative payloads.
  writeEntry(root, { kind: 'capture-toggle', by: 'init-migration', host: 'claude-code', payload: { from: false, to: true, method: 'non-interactive-default' } });
  writeEntry(root, { kind: 'cross-project-read', by: 'slash-direct', host: 'claude-code', payload: { scope: 'all', projects_read: ['p1','p2'], tool: 'brief' } });
  writeMutationPair(root, { tool: 'forget', args: { memory_id: 'mem_x' }, host: 'claude-code', kind: 'forget', payload: { memory_id: 'mem_x', reason: 'test' } });
  writeMutationPair(root, { tool: 'unlock', args: {}, host: 'claude-code', kind: 'unlock', payload: { lock_holder_pid: 1234, stale_for_seconds: 320 } });
  writeMutationPair(root, { tool: 'rebuild-vectors', args: {}, host: 'claude-code', kind: 'rebuild', payload: { index: 'vector', cards_processed: 0, duration_ms: 0 } });
  writeMutationPair(root, { tool: 'promote', args: { memory_id: 'mem_y' }, host: 'claude-code', kind: 'promote', payload: { memory_id: 'mem_y', from_privacy: 'local', to_privacy: 'global' } });
  writeEntry(root, { kind: 'cross-project-export', by: 'slash-direct', host: 'claude-code', payload: { scope: 'all', exported_count: 3, target_path: '/tmp/x.json' } });
  writeEntry(root, { kind: 'save', by: 'mcp-autonomous', host: 'cursor', payload: { memory_id: 'mem_z', memory_type: 'pattern', privacy: 'local' } });
  writeEntry(root, { kind: 'gate-violation', by: 'mcp-autonomous', host: 'codex', payload: { tool: 'forget', requested_scope: 'autonomous-call', denial_reason: 'gate2', error: 'slash_only_in_v030' } });

  const lines = readAuditLog(root);
  // Each writeMutationPair = 2 lines, so total expected: 4 + 4*2 + 0 = 12 lines
  // (2 single + 4 single + 4 mutation pairs × 2 = 14 actually)
  // Recount: writeEntry calls: 4 + 1 (save) + 1 (gate-violation) + 1 (export) = 7
  //          writeMutationPair × 4 = 8 (= 4 pairs × 2)
  // Wait: capture-toggle(1) + cross-project-read(1) + forget pair(2) + unlock pair(2) + rebuild pair(2) + promote pair(2) + cross-project-export(1) + save(1) + gate-violation(1) = 13
  assert.strictEqual(lines.length, 13, `expected 13 audit-log lines, got ${lines.length}`);
  for (const line of lines) {
    assert.ok(validate(line), `${line.kind} failed validation: ${JSON.stringify(validate.errors)}`);
  }
});

test('R4-K: writeMutationPair emits exactly 2 lines with same `at`', () => {
  const root = mkTmpRoot();
  writeMutationPair(root, {
    tool: 'forget', args: { memory_id: 'mem_x' }, host: 'claude-code',
    kind: 'forget', payload: { memory_id: 'mem_x', reason: 'test' }
  });
  const lines = readAuditLog(root);
  assert.strictEqual(lines.length, 2, 'mutation pair must emit exactly 2 lines');
  assert.strictEqual(lines[0].kind, 'mutation-consent');
  assert.strictEqual(lines[1].kind, 'forget');
  // R4-K within-1ms assertion — actually byte-identical because we share `at`.
  assert.strictEqual(lines[0].at, lines[1].at, 'mutation-consent + main share at timestamp');
});

test('R4-E: malformed payload throws schema violation', () => {
  const root = mkTmpRoot();
  assert.throws(() => {
    writeEntry(root, {
      kind: 'capture-toggle',
      by: 'slash-direct',
      host: 'claude-code',
      payload: { from: false }  // missing required to + method
    });
  }, /AUDIT_LOG_SCHEMA_VIOLATION|schema violation/);
});
