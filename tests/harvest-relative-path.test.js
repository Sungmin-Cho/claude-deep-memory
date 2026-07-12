'use strict';
// ITEM-3-r5: harvest with relative artifactPath must store absolute resolved path in provenance
// so audit cross-cwd does not produce false-positive missing/content-drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const REPO_ROOT = path.join(__dirname, '..');

test('ITEM-3-r5: relative artifactPath is resolved to absolute in source_artifacts[].path', async () => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-relpath-'));
  // Use a path relative to REPO_ROOT — the test runner's cwd is REPO_ROOT.
  const relPath = './tests/fixtures/sample-recurring-findings.json';
  try {
    const cards = await harvestArtifact({
      artifactPath: relPath,
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.ok(cards.length >= 1, 'Expected at least 1 card');
    const c = cards[0];
    const storedPath = c.envelope?.provenance?.source_artifacts?.[0]?.path;
    assert.ok(typeof storedPath === 'string', 'source_artifacts[0].path must be a string');
    // After path.resolve + redactString (ITEM-2 r1), the path is either:
    //   ~/... (if REPO_ROOT is under homedir — typical developer machine), OR
    //   an absolute path starting with / (if REPO_ROOT is under e.g. /srv/ — not home).
    // In BOTH cases it must be absolute (not start with . or ..):
    assert.ok(
      !storedPath.startsWith('.'),
      `source_artifacts[0].path must be absolute (not relative), got: ${storedPath}`
    );
    // And it must NOT be just the original relative string:
    assert.notStrictEqual(
      storedPath,
      relPath,
      'source_artifacts[0].path must NOT equal the raw relative input string'
    );
    // Check that it corresponds to an absolute path pointing to the fixture
    // (after redaction, homedir prefix is replaced by ~, so we match the suffix):
    assert.ok(
      storedPath.endsWith(path.join('tests', 'fixtures', 'sample-recurring-findings.json')),
      `Expected path to end with fixture filename, got: ${storedPath}`
    );
  } finally {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
  }
});

test('ITEM-3-r5: absolute artifactPath is unchanged in provenance (back-compat)', async () => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-relpath-abs-'));
  // Existing tests always pass absolute paths — verify no regression.
  const absPath = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-recurring-findings.json');
  try {
    const cards = await harvestArtifact({
      artifactPath: absPath,
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.ok(cards.length >= 1, 'Expected at least 1 card');
    const storedPath = cards[0].envelope?.provenance?.source_artifacts?.[0]?.path;
    assert.ok(
      storedPath.endsWith(path.join('tests', 'fixtures', 'sample-recurring-findings.json')),
      `Expected absolute path preserved in provenance, got: ${storedPath}`
    );
    assert.ok(!storedPath.startsWith('.'), 'Path must not be relative');
  } finally {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
  }
});
