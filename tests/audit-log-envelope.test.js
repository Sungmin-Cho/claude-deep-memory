'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'audit-log-entry.schema.json');

function compile() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

test('audit-log envelope validates 10 kind variants', () => {
  const validate = compile();
  const samples = [
    {
      at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'capture-toggle',
      by: 'slash-direct', host: 'claude-code',
      payload: { from: false, to: true, method: 'prompted' }
    },
    {
      at: '2026-05-22T00:00:01Z', id: '01H2', kind: 'cross-project-read',
      by: 'slash-direct', host: 'claude-code',
      payload: { scope: 'all', projects_read: ['p1', 'p2'], tool: 'brief' }
    },
    {
      at: '2026-05-22T00:00:02Z', id: '01H3', kind: 'mutation-consent',
      by: 'slash-direct', host: 'claude-code',
      payload: { tool: 'unlock', args: {} }
    },
    {
      at: '2026-05-22T00:00:03Z', id: '01H4', kind: 'gate-violation',
      by: 'mcp-autonomous', host: 'codex',
      payload: { tool: 'audit', requested_scope: 'unlock', denial_reason: 'gate2', error: 'slash_only_in_v030' }
    },
    {
      at: '2026-05-22T00:00:04Z', id: '01H5', kind: 'save',
      by: 'mcp-autonomous', host: 'cursor',
      payload: { memory_id: 'mem_x', memory_type: 'pattern', privacy: 'local' }
    },
    {
      at: '2026-05-22T00:00:05Z', id: '01H6', kind: 'forget',
      by: 'slash-direct', host: 'claude-code',
      payload: { memory_id: 'mem_y', reason: 'deprecated' }
    },
    {
      at: '2026-05-22T00:00:06Z', id: '01H7', kind: 'cross-project-export',
      by: 'slash-direct', host: 'claude-code',
      payload: { scope: 'all', exported_count: 42, target_path: '/tmp/x.json' }
    },
    {
      at: '2026-05-22T00:00:07Z', id: '01H8', kind: 'promote',
      by: 'slash-direct', host: 'claude-code',
      payload: { memory_id: 'mem_z', from_privacy: 'local', to_privacy: 'global' }
    },
    {
      at: '2026-05-22T00:00:08Z', id: '01H9', kind: 'rebuild',
      by: 'slash-direct', host: 'claude-code',
      payload: { index: 'vector', cards_processed: 50, duration_ms: 8000 }
    },
    {
      at: '2026-05-22T00:00:09Z', id: '01HA', kind: 'unlock',
      by: 'slash-direct', host: 'claude-code',
      payload: { lock_holder_pid: 1234, stale_for_seconds: 320 }
    }
  ];
  for (const s of samples) {
    assert.ok(validate(s), `${s.kind} should validate: ${JSON.stringify(validate.errors)}`);
  }
});

test('audit-log envelope rejects unknown kind', () => {
  const validate = compile();
  const rec = {
    at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'bogus-kind',
    by: 'slash-direct', host: 'claude-code', payload: {}
  };
  assert.strictEqual(validate(rec), false, 'should reject unknown kind');
});

test('audit-log envelope rejects unknown by value', () => {
  const validate = compile();
  const rec = {
    at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'forget',
    by: 'random-user', host: 'claude-code',
    payload: { memory_id: 'mem_x', reason: 'test' }
  };
  assert.strictEqual(validate(rec), false, 'should reject unknown by');
});

test('audit-log envelope: by enum includes cli-flag (PR1-H)', () => {
  const validate = compile();
  const rec = {
    at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'capture-toggle',
    by: 'cli-flag', host: 'claude-code',
    payload: { from: false, to: true, method: 'cli-flag' }
  };
  assert.ok(validate(rec), `cli-flag should be valid: ${JSON.stringify(validate.errors)}`);
});

test('audit-log envelope: capture-toggle payload requires from/to/method', () => {
  const validate = compile();
  const rec = {
    at: '2026-05-22T00:00:00Z', id: '01H1', kind: 'capture-toggle',
    by: 'slash-direct', host: 'claude-code',
    payload: { from: false }  // missing to + method
  };
  assert.strictEqual(validate(rec), false, 'should reject incomplete capture-toggle payload');
});
