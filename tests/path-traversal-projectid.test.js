'use strict';
// ITEM-2-r4: path traversal guard — harvestArtifact with crafted projectId
// must throw INVALID_PROJECT_ID BEFORE creating any file outside memoryRoot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const FIXTURE = path.join(__dirname, 'fixtures/sample-recurring-findings.json');

test('harvestArtifact: projectId="../../escape" throws INVALID_PROJECT_ID, no file created outside memoryRoot', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-traversal-'));
  try {
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: FIXTURE,
        sourceKind: 'review-recurring',
        memoryRoot: tmp,
        projectId: '../../escape',
        skipDistillStepB: true,
      }),
      (e) => {
        assert.strictEqual(e.code, 'INVALID_PROJECT_ID', `Expected INVALID_PROJECT_ID, got: ${e.code} — ${e.message}`);
        return true;
      }
    );
    // No lease file created outside .leases/
    const leaseGlob = path.join(tmp, '.leases');
    const leases = fs.existsSync(leaseGlob) ? fs.readdirSync(leaseGlob) : [];
    assert.strictEqual(leases.length, 0, `No lease files should exist: ${leases.join(', ')}`);
    // No card created outside cards/
    const cardsRoot = path.join(tmp, 'cards');
    assert.ok(!fs.existsSync(cardsRoot), 'No cards directory created');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('harvestArtifact: projectId="../etc/passwd-" throws INVALID_PROJECT_ID', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-traversal2-'));
  try {
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: FIXTURE,
        sourceKind: 'review-recurring',
        memoryRoot: tmp,
        projectId: '../etc/passwd-',
        skipDistillStepB: true,
      }),
      (e) => e.code === 'INVALID_PROJECT_ID'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('harvestArtifact: projectId="" throws INVALID_PROJECT_ID', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-traversal3-'));
  try {
    await assert.rejects(
      () => harvestArtifact({
        artifactPath: FIXTURE,
        sourceKind: 'review-recurring',
        memoryRoot: tmp,
        projectId: '',
        skipDistillStepB: true,
      }),
      (e) => e.code === 'INVALID_PROJECT_ID'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('harvestArtifact: valid projectId still succeeds normally (regression guard)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-traversal-ok-'));
  try {
    const cards = await harvestArtifact({
      artifactPath: FIXTURE,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    assert.strictEqual(cards.length, 1, 'valid projectId produces cards normally');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
