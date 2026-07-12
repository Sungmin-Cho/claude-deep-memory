'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getSchema, SCHEMA_NAMES } = require('../scripts/lib/schema-registry');
const { PROJECT_PROFILE_SCHEMA } = require('../scripts/lib/project-profile-validator');

const root = path.resolve(__dirname, '..');
const EXPECTED = [
  'audit-log-entry',
  'memory-card',
  'memory-card-distill-output',
  'memory-event',
  'memory-hook-event',
  'project-profile',
];

test('schema registry exposes immutable normative schemas', () => {
  assert.deepEqual(SCHEMA_NAMES, EXPECTED);
  for (const name of EXPECTED) {
    const schema = getSchema(name);
    assert.equal(typeof schema, 'object');
    assert.equal(Object.isFrozen(schema), true, name);
  }
});

test('project-profile schema remains Task-1-owned', () => {
  assert.strictEqual(getSchema('project-profile'), PROJECT_PROFILE_SCHEMA);
});

test('unknown schema fails with a typed error', () => {
  assert.throws(() => getSchema('missing'), (error) => error.code === 'UNKNOWN_SCHEMA');
});

test('every Task 2 runtime schema consumer uses the registry, not filesystem reads', () => {
  const consumers = [
    ['scripts/lib/llm-bridge.js', ['memory-card-distill-output']],
    ['scripts/lib/event-dispatcher.js', ['memory-event', 'memory-hook-event']],
    ['scripts/lib/audit-log.js', ['audit-log-entry']],
    ['scripts/audit.js', ['memory-card']],
  ];
  for (const [relative, names] of consumers) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /require\(['"]\.\/(?:lib\/)?schema-registry['"]\)/, relative);
    assert.doesNotMatch(source, /require\(['"][^'"]*schemas\/[A-Za-z0-9_.-]+\.json['"]\)/, relative);
    assert.doesNotMatch(source, /readFileSync\([^)]*schemas\/[A-Za-z0-9_.-]+\.json/, relative);
    for (const name of names) {
      assert.match(source, new RegExp(`getSchema\\(['"]${name}['"]\\)`), `${relative}: ${name}`);
    }
  }
});
