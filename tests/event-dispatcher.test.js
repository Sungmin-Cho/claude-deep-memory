'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'memory-hook-event.schema.json');

test('memory-hook-event schema validates valid record', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const rec = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: '01J0XKMRWQ7B9YZ8AE6F3VHTN5',
      generated_at: '2026-05-22T07:14:32.811Z',
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'host-stdin://claude-code/PostToolUse' }] },
      host: 'claude-code',
      session_id: 'claude-cc-7a3f',
      project_id: 'proj_8e2c'
    },
    payload: {
      source_kind: 'hook-post-tool-use',
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: '2026-05-22T07:14:32.811Z',
      tool_name: 'Edit',
      tool_input_summary: 'edited src/auth.ts',
      tool_output_summary: '12 lines changed',
      raw_chars_in: 4321,
      raw_chars_out: 1024,
      redaction: { rules_matched: 1, chars_masked: 18, passes: ['pass0'] }
    }
  };
  assert.ok(validate(rec), JSON.stringify(validate.errors));
});

test('memory-hook-event schema rejects record without required envelope.host', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const rec = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: '01J0XKMRWQ7B9YZ8AE6F3VHTN5',
      generated_at: '2026-05-22T07:14:32.811Z',
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'host-stdin://x' }] },
      // host missing
      session_id: 's1',
      project_id: 'proj_x'
    },
    payload: {
      source_kind: 'hook-post-tool-use',
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: '2026-05-22T07:14:32.811Z',
      raw_chars_in: 0,
      raw_chars_out: 0,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  };
  assert.strictEqual(validate(rec), false, 'should reject record without envelope.host');
});

// -----------------------------------------------------------------------
// Dispatcher tests (α.11)
// -----------------------------------------------------------------------

const { dispatch } = require('../scripts/lib/event-dispatcher');

test('dispatcher: envelope-shaped memory-hook-event routes to hook validator', () => {
  const line = JSON.stringify({
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: '01H',
      generated_at: '2026-05-01T00:00:00Z',
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'host-stdin://claude-code/x' }] },
      host: 'claude-code',
      session_id: 's',
      project_id: 'p'
    },
    payload: {
      source_kind: 'hook-post-tool-use',
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: '2026-05-01T00:00:00Z',
      raw_chars_in: 0,
      raw_chars_out: 0,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  });
  const r = dispatch(line);
  assert.strictEqual(r.routed, 'memory-hook-event');
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('dispatcher: legacy flat event wraps via adapter (R4-H)', () => {
  const flat = JSON.stringify({
    event_key: 'abc123',
    source: 'recurring-findings',
    run_id: '01HX',
    at: '2026-04-01T00:00:00Z',
    cards_count: 3,
    project_id: 'p1'
  });
  const r = dispatch(flat);
  assert.strictEqual(r.routed, 'memory-event-legacy-wrapped');
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('dispatcher: unknown shape quarantines', () => {
  const r = dispatch('{"random":"junk"}');
  assert.strictEqual(r.routed, 'quarantine');
});

test('dispatcher: unparseable line quarantines', () => {
  const r = dispatch('not json at all');
  assert.strictEqual(r.routed, 'quarantine');
  assert.strictEqual(r.reason, 'unparseable');
});

test('dispatcher: envelope-shaped memory-event routes to event validator', () => {
  const line = JSON.stringify({
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.1.3',
      artifact_kind: 'memory-event',
      run_id: '01H',
      generated_at: '2026-05-01T00:00:00Z',
      schema: { name: 'memory-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: 'x' }] }
    },
    payload: {
      event_key: 'a'.repeat(64),
      source_artifact_id: 'src_1',
      event_kind: 'harvested',
      cards_count: 1,
      at: '2026-05-01T00:00:00Z'
    }
  });
  const r = dispatch(line);
  assert.strictEqual(r.routed, 'memory-event');
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});

test('memory-hook-event schema rejects unknown source_kind', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const rec = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: '01J0XKMRWQ7B9YZ8AE6F3VHTN5',
      generated_at: '2026-05-22T07:14:32.811Z',
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: 'a'.repeat(40), branch: 'main', dirty: 'false' },
      provenance: { source_artifacts: [{ path: 'x' }] },
      host: 'claude-code',
      session_id: 's1',
      project_id: 'proj_x'
    },
    payload: {
      source_kind: 'hook-unknown-future-kind',  // not in enum
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: '2026-05-22T07:14:32.811Z',
      raw_chars_in: 0,
      raw_chars_out: 0,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  };
  assert.strictEqual(validate(rec), false, 'should reject unknown source_kind');
});
