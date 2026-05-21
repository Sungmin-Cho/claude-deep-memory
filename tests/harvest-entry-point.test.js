'use strict';
// ITEM-6-r3: harvest.js CLI entry point (require.main === module).
// v0.1.0 CLI accepts a single <artifact-path> --kind <sourceKind> [--project <projectId>].
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..');
const HARVEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'harvest.js');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-recurring-findings.json');

test('ITEM-6-r3: CLI exit 0 and latest-harvest.json written with cards_count=1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cli-harvest-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cli-proj-'));
  try {
    const result = spawnSync(
      process.execPath,
      [HARVEST_SCRIPT, FIXTURE, '--kind', 'review-recurring', '--project', 'proj_aaaaaaaaaaaa'],
      {
        cwd: tmpProject,
        env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    // Should exit 0
    assert.strictEqual(result.status, 0,
      `CLI exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    // latest-harvest.json must exist in <tmpProject>/.deep-memory/
    const harvestPath = path.join(tmpProject, '.deep-memory', 'latest-harvest.json');
    assert.ok(fs.existsSync(harvestPath), `latest-harvest.json not found at ${harvestPath}`);
    const summary = JSON.parse(fs.readFileSync(harvestPath, 'utf8'));
    // The fixture has 2 findings; F1 filters the empty-evidence one → 1 card.
    assert.strictEqual(summary.cards_count, 1, `Expected 1 card, got ${summary.cards_count}`);
    assert.strictEqual(summary.sourceKind, 'review-recurring');
    assert.strictEqual(summary.projectId, 'proj_aaaaaaaaaaaa');
    assert.ok(Array.isArray(summary.memory_ids), 'memory_ids must be an array');
    assert.strictEqual(summary.memory_ids.length, 1, 'memory_ids must have 1 entry');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('ITEM-6-r3: CLI missing args exits 1 with usage message', () => {
  const result = spawnSync(
    process.execPath,
    [HARVEST_SCRIPT],
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.strictEqual(result.status, 1, 'Missing args should exit 1');
  assert.ok(
    result.stderr.includes('Usage:') || result.stderr.includes('sourceKind'),
    `Expected usage message in stderr, got: ${result.stderr}`
  );
});

test('ITEM-6-r3: CLI missing --kind exits 1', () => {
  const result = spawnSync(
    process.execPath,
    [HARVEST_SCRIPT, FIXTURE],  // missing --kind
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.strictEqual(result.status, 1, 'Missing --kind should exit 1');
});

test('ITEM-6-r3: importing harvest.js is unaffected by the require.main block (no side effects)', () => {
  // Already required above in other tests — verify module is importable without CLI args
  const harvest = require('../scripts/harvest');
  assert.strictEqual(typeof harvest.harvestArtifact, 'function', 'harvestArtifact still exported');
  assert.strictEqual(typeof harvest.memoryIdFor, 'function', 'memoryIdFor still exported');
});
