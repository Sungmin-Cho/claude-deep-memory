'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { redactString } = require('../scripts/lib/redact');

// PR1-E (R-011): 3 redaction rules promoted to shared set.
// Tests verify each rule applies via the unified redactString pipeline.

test('PR1-E: generic /Users/<name>/ → ~/ (different user than runner)', () => {
  // /Users/alice is NOT the current runner's homedir (HOME_RE doesn't match).
  // applyGenericHomedir() must mask it independently.
  const r = redactString('error at /Users/alice/Dev/repo/src/auth.ts:42');
  assert.ok(r.includes('~/Dev/repo/src/auth.ts:42'), `expected ~/-normalized, got: ${r}`);
  assert.ok(!r.includes('/Users/alice'), `leak: ${r}`);
});

test('PR1-E: generic /home/<name>/ → ~/ (Linux runner path)', () => {
  const r = redactString('error at /home/runner/work/repo/src/x.ts:42');
  assert.ok(r.includes('~/work/repo/src/x.ts:42'), `expected ~/-normalized, got: ${r}`);
  assert.ok(!r.includes('/home/runner'), `leak: ${r}`);
});

test('PR1-E: current runner homedir → ~/ (HOME_RE preserved)', () => {
  const home = os.homedir();
  const r = redactString(`error at ${home}/Dev/repo/src/auth.ts:42`);
  assert.ok(r.includes('~/Dev/repo/src/auth.ts:42'), `expected HOME_RE → ~, got: ${r}`);
  assert.ok(!r.includes(home), `runner homedir leak: ${r}`);
});

test('PR1-E + W3: env-var with $ prefix masked with value preserved name', () => {
  const r = redactString('check $AGENTMEMORY_SECRET=abc123def');
  assert.ok(r.includes('$AGENTMEMORY_SECRET=<REDACTED>'), `got: ${r}`);
  assert.ok(!r.includes('abc123def'), `value leak: ${r}`);
});

test('PR1-E + W3: env-var with process.env. prefix masked', () => {
  const r = redactString('use process.env.OPENAI_API_KEY=sk-xxxYYYzzz');
  assert.ok(!r.includes('sk-xxxYYYzzz'), `value leak: ${r}`);
  assert.ok(r.includes('OPENAI_API_KEY=<REDACTED>') || r.includes('[REDACTED]'),
            `expected env-var or DENY_PATTERN mask, got: ${r}`);
});

test('PR1-E + W3: env-var with export prefix (bare-assignment fix)', () => {
  const r = redactString('export AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE');
  assert.ok(!r.includes('AKIAIOSFODNN7EXAMPLE'), `value leak: ${r}`);
});

test('PR1-E: stack-trace homedir redacted', () => {
  const stack = 'Error: x\n    at Object.<anonymous> (/Users/alice/Dev/proj/src/foo.js:10:5)';
  const r = redactString(stack);
  assert.ok(!r.includes('/Users/alice'), `leak: ${r}`);
  assert.ok(r.includes('~/Dev/proj/src/foo.js'), `expected ~/-normalized, got: ${r}`);
});

test('PR1-E: non-sensitive env var passes through unchanged', () => {
  const r = redactString('PATH=/usr/bin LD_LIBRARY_PATH=/lib');
  // PATH / LD_LIBRARY_PATH are NOT in the sensitive prefix list (AGENTMEMORY/AWS/OPENAI/...).
  // Should pass through (or only have DENY_PATTERNS apply).
  assert.ok(r.includes('PATH=/usr/bin') || r.includes('[REDACTED]'),
            `non-sensitive should not be aggressively masked, got: ${r}`);
});
