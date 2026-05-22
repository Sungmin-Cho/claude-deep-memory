'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');
const path = require('node:path');
const { wrapLegacy } = require('../scripts/lib/legacy-adapter');

const EVENT_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schemas', 'memory-event.schema.json'), 'utf8')
);

function makeValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(EVENT_SCHEMA);
}

test('wrapLegacy: v0.1.x flat event with string source produces schema-valid envelope', () => {
  const validate = makeValidator();
  const flat = {
    event_key: 'abc123',
    source: 'recurring-findings',
    run_id: '01HX',
    at: '2026-04-01T00:00:00Z',
    cards_count: 3,
    project_id: 'p1'
  };
  const wrapped = wrapLegacy(flat);
  assert.ok(validate(wrapped),
    `wrapped record should validate: ${JSON.stringify(validate.errors)}`);
  assert.strictEqual(wrapped.schema_version, '1.0');
  assert.strictEqual(wrapped.envelope.artifact_kind, 'memory-event');
  assert.match(wrapped.envelope.producer_version, /^\d+\.\d+\.\d+$/,
    'producer_version must be SemVer');
  assert.match(wrapped.payload.event_key, /^[a-f0-9]{64}$/,
    'event_key must be normalized to 64-hex');
  assert.strictEqual(wrapped.envelope.provenance.source_artifacts[0].path, 'recurring-findings');
  assert.strictEqual(wrapped.payload.event_kind, 'harvested');
  assert.strictEqual(wrapped.payload.cards_count, 3);
});

test('wrapLegacy: v0.1.x flat event with object source extracts .path', () => {
  const validate = makeValidator();
  const flat = {
    event_key: 'def456',
    source: { adapter_id: 'adp_review', path: '/tmp/foo.json', content_hash: 'sha256:xyz', captured_at: '2026-04-02T00:00:00Z' },
    run_id: '01HY',
    at: '2026-04-02T00:00:00Z',
    cards_count: 1,
    project_id: 'p1'
  };
  const wrapped = wrapLegacy(flat);
  assert.ok(validate(wrapped),
    `object-source wrap should validate: ${JSON.stringify(validate.errors)}`);
  assert.strictEqual(wrapped.envelope.provenance.source_artifacts[0].path, '/tmp/foo.json');
});

test('wrapLegacy: already-64-hex event_key passes through unchanged', () => {
  const flat = {
    event_key: 'a'.repeat(64),  // already valid
    source: 's',
    run_id: 'r',
    at: '2026-04-01T00:00:00Z',
    cards_count: 0,
    project_id: 'p'
  };
  const wrapped = wrapLegacy(flat);
  assert.strictEqual(wrapped.payload.event_key, 'a'.repeat(64), 'should preserve already-valid event_key');
});

test('wrapLegacy: missing source defaults to "legacy"', () => {
  const flat = {
    event_key: 'k',
    at: '2026-04-01T00:00:00Z',
    cards_count: 0,
    run_id: 'r'
  };
  const wrapped = wrapLegacy(flat);
  assert.strictEqual(wrapped.envelope.provenance.source_artifacts[0].path, 'legacy');
});

test('legacy fixture file validates after wrap (R4-H)', () => {
  const validate = makeValidator();
  const fixturePath = path.join(__dirname, 'fixtures', 'legacy', 'v01x-flat-event.jsonl');
  const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
  for (const line of lines) {
    const flat = JSON.parse(line);
    const wrapped = wrapLegacy(flat);
    assert.ok(validate(wrapped),
      `fixture line ${flat.event_key} should validate: ${JSON.stringify(validate.errors)}`);
  }
});
