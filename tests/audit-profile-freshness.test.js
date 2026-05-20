'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectStaleProfile, PROFILE_MAX_AGE_DAYS_DEFAULT } = require('../scripts/audit');

function plantProfile(projectDir, generatedAt) {
  const dir = path.join(projectDir, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'project-profile.json'),
    JSON.stringify({ project_id: 'proj_test', generated_at: generatedAt })
  );
}

test('Task 5.6: project-profile older than profile_max_age_days → stale=true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    const oldDate = new Date(Date.now() - 31 * 86400 * 1000).toISOString();
    plantProfile(tmp, oldDate);
    const result = detectStaleProfile(tmp);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.stale, true);
    assert.ok(result.age_days > PROFILE_MAX_AGE_DAYS_DEFAULT);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.6: project-profile within freshness window → stale=false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    plantProfile(tmp, new Date().toISOString());
    const result = detectStaleProfile(tmp);
    assert.strictEqual(result.stale, false);
    assert.ok(result.age_days < 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.6: custom maxAgeDays threshold honored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    plantProfile(tmp, new Date(Date.now() - 5 * 86400 * 1000).toISOString());
    assert.strictEqual(detectStaleProfile(tmp, { maxAgeDays: 30 }).stale, false);
    assert.strictEqual(detectStaleProfile(tmp, { maxAgeDays: 3 }).stale, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.6: missing profile → exists=false, stale=false (init guidance is elsewhere)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    const result = detectStaleProfile(tmp);
    assert.strictEqual(result.exists, false);
    assert.strictEqual(result.stale, false);
    assert.strictEqual(result.age_days, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.6: corrupted profile → exists=true, stale=true, parse_error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    const dir = path.join(tmp, '.deep-memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project-profile.json'), '{ NOT JSON');
    const result = detectStaleProfile(tmp);
    assert.strictEqual(result.exists, true);
    assert.strictEqual(result.stale, true);
    assert.strictEqual(result.parse_error, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.6: profile without generated_at field → stale=true', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-prof-'));
  try {
    const dir = path.join(tmp, '.deep-memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project-profile.json'), JSON.stringify({ project_id: 'x' }));
    const result = detectStaleProfile(tmp);
    assert.strictEqual(result.stale, true);
    assert.strictEqual(result.age_days, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
