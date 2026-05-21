'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

test('ITEM-2: source_artifacts[].path is redacted — home dir never leaks into persisted card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-redact-'));
  try {
    // artifactPath is inside os.homedir() — a typical real-world path
    const artifactPath = path.join(
      __dirname,
      'fixtures/sample-recurring-findings.json'
    );
    // Confirm the path really is under homedir (test validity guard)
    assert.ok(
      artifactPath.startsWith(os.homedir()),
      'fixture path must be under homedir for this test to be meaningful'
    );

    const cards = await harvestArtifact({
      artifactPath,
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });

    assert.strictEqual(cards.length, 1);
    const card = cards[0];
    const saPath = card.envelope.provenance.source_artifacts[0].path;

    // Must start with ~ (home collapsed) and NOT contain the raw homedir
    assert.ok(
      saPath.startsWith('~/'),
      `source_artifacts[0].path should start with "~/" but got: ${saPath}`
    );
    assert.ok(
      !saPath.includes(os.homedir()),
      `source_artifacts[0].path must not contain raw homedir but got: ${saPath}`
    );

    // Also verify the persisted on-disk card has the same redacted path
    const onDisk = path.join(
      tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa', card.payload.memory_id + '.json'
    );
    const persisted = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
    const diskPath = persisted.envelope.provenance.source_artifacts[0].path;
    assert.ok(
      diskPath.startsWith('~/'),
      `persisted card path should start with "~/" but got: ${diskPath}`
    );
    assert.ok(
      !diskPath.includes(os.homedir()),
      `persisted card must not contain raw homedir but got: ${diskPath}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
