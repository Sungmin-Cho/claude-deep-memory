'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wrap, ulidLike } = require('../scripts/lib/envelope');

test('envelope.wrap embeds producer + run_id + payload', () => {
  const out = wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload: { hello: 'world' },
  });
  assert.strictEqual(out.envelope.producer, 'deep-memory');
  assert.match(out.envelope.run_id, /^[a-z0-9_]+$/); // underscore separator
  assert.match(out.envelope.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepStrictEqual(out.payload, { hello: 'world' });
});

test('envelope.wrap satisfies suite git constraints: dirty is boolean|"unknown", head is hex or git omitted', () => {
  const out = wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload: {},
  });
  if (out.envelope.git) {
    // If git present, dirty must be boolean or literal "unknown"
    const d = out.envelope.git.dirty;
    assert.ok(
      d === true || d === false || d === 'unknown',
      `dirty must be boolean|"unknown", got ${typeof d} ${d}`
    );
    // head must be hex 7-40 chars, or git is omitted entirely
    assert.match(out.envelope.git.head, /^[a-f0-9]{7,40}$/);
  }
});

test('envelope.ulidLike returns lowercase alphanumeric + underscore separator', () => {
  const id = ulidLike();
  assert.match(id, /^[a-z0-9]+_[a-f0-9]{16}$/);
});
