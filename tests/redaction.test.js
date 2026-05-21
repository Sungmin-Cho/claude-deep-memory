'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { redactString, redactObject, REDACT_TAG } = require('../scripts/lib/redact');
const fixture = require('./fixtures/dangerous-secrets.json');

test('redactString masks all known secret patterns', () => {
  // v0.1.3 — HOME_RE is derived from os.homedir(), but the fixture file hardcodes
  // `/Users/sungmin/...` which only matches on the maintainer's macOS. On Linux CI
  // (`/home/runner`) the literal path doesn't match HOME_RE and the assertion fails.
  // Substitute the literal `/Users/sungmin` prefix with the runner's actual homedir
  // so the test exercises the home-dir collapse path on any platform.
  const HOME = os.homedir();
  for (const raw of fixture.samples) {
    const sample = raw.replace('/Users/sungmin', HOME);
    const out = redactString(sample);
    assert.ok(out.includes(REDACT_TAG) || out.includes('~'),
      `pattern not masked: ${sample} -> ${out}`);
  }
});

test('redactObject recurses into nested arrays/objects', () => {
  const input = {
    a: 'api_key=sk-abcdefghijklmnopqrstuvwx',
    b: ['user@example.com', { c: '/Users/x/y' }],
  };
  const out = redactObject(input);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.includes(REDACT_TAG), 'expected REDACT_TAG in output');
  assert.ok(!serialized.includes('sk-abcdefghijklmnopqrstuvwx'),
    'api key should be masked');
});

test('redactString respects suppressions allow_patterns', () => {
  const input = 'SQL_INJECTION_TEST_TAG=please_keep';
  const out = redactString(input, { allowPatterns: ['SQL_INJECTION_TEST_TAG'] });
  assert.ok(out.includes('SQL_INJECTION_TEST_TAG'),
    `allow pattern should keep tag: got ${out}`);
});
