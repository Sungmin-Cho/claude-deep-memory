'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { detectSourceRenames } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-rename-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

test('Task 5.5: source file unchanged → no unresolved entries (clean baseline)', async () => {
  const tmp = mkRoot();
  try {
    const fixture = path.join(tmp, 'fixture.json');
    fs.copyFileSync(path.join(__dirname, 'fixtures/sample-recurring-findings.json'), fixture);
    await harvestArtifact({
      artifactPath: fixture,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    const result = detectSourceRenames(tmp, { projectId: 'proj_aaaaaaaaaaaa' });
    assert.ok(result.scanned >= 1);
    assert.deepStrictEqual(result.unresolved, [],
      'baseline: source file unchanged since harvest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.5: source file content mutated → content_drift reported', async () => {
  const tmp = mkRoot();
  try {
    const fixture = path.join(tmp, 'fixture.json');
    fs.copyFileSync(path.join(__dirname, 'fixtures/sample-recurring-findings.json'), fixture);
    await harvestArtifact({
      artifactPath: fixture,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // mutate source content → hash should drift
    const raw = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    raw.payload.findings.push({
      title: 'new finding after harvest',
      category: 'audit',
      first_seen: '2026-05-19T00:00:00Z',
      evidence: ['mutation'],
      tags: ['mutated'],
    });
    fs.writeFileSync(fixture, JSON.stringify(raw));
    const result = detectSourceRenames(tmp, { projectId: 'proj_aaaaaaaaaaaa' });
    assert.strictEqual(result.unresolved.length, 1);
    assert.strictEqual(result.unresolved[0].reason, 'content_drift');
    assert.notStrictEqual(result.unresolved[0].expected_hash, result.unresolved[0].actual_hash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.5: source file deleted → missing reported', async () => {
  const tmp = mkRoot();
  try {
    const fixture = path.join(tmp, 'fixture.json');
    fs.copyFileSync(path.join(__dirname, 'fixtures/sample-recurring-findings.json'), fixture);
    await harvestArtifact({
      artifactPath: fixture,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    fs.unlinkSync(fixture);
    const result = detectSourceRenames(tmp, { projectId: 'proj_aaaaaaaaaaaa' });
    assert.strictEqual(result.unresolved.length, 1);
    assert.strictEqual(result.unresolved[0].reason, 'missing');
    assert.strictEqual(result.unresolved[0].actual_hash, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.5: empty memory_root returns zeros (no error)', () => {
  const tmp = mkRoot();
  try {
    const result = detectSourceRenames(tmp);
    assert.deepStrictEqual(result, { scanned: 0, unresolved: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ITEM-3-r2: harvest under HOME → audit sees clean baseline (no false-positive missing)', async () => {
  const memRoot = mkRoot();
  let homeFixtureDir = null;
  try {
    // Create a temp dir inside homedir() so the path starts with homedir()
    homeFixtureDir = fs.mkdtempSync(path.join(os.homedir(), '.dm-audit-test-'));
    const fixtureInHome = path.join(homeFixtureDir, 'sample.json');
    fs.copyFileSync(path.join(__dirname, 'fixtures/sample-recurring-findings.json'), fixtureInHome);

    // Harvest using the homedir-rooted path as artifactPath
    await harvestArtifact({
      artifactPath: fixtureInHome,
      sourceKind: 'review-recurring',
      memoryRoot: memRoot,
      projectId: 'proj_333333333333',
      skipDistillStepB: true,
    });

    // Verify the persisted card uses a ~/ path (harvest redacts home to ~/)
    // Then detectSourceRenames must not report false-positive missing
    const result = detectSourceRenames(memRoot, { projectId: 'proj_333333333333' });
    assert.ok(result.scanned >= 1, 'at least one card scanned');
    assert.deepStrictEqual(result.unresolved, [],
      `Expected no false-positive missing, got: ${JSON.stringify(result.unresolved)}`);
  } finally {
    fs.rmSync(memRoot, { recursive: true, force: true });
    if (homeFixtureDir) {
      try { fs.rmSync(homeFixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
});
