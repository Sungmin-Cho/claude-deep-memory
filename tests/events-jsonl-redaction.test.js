'use strict';
// ITEM-4-r4: events JSONL must not contain home-directory path in source.path.
// The event row's source.path must be redacted (~/... prefix) rather than raw.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const FIXTURE_SRC = path.join(__dirname, 'fixtures/sample-recurring-findings.json');

test('events JSONL source.path is redacted — home dir never leaks into events JSONL', async () => {
  // Create a copy of the fixture inside homedir() so the path starts with homedir()
  const homeDir = os.homedir();
  const homeFixtureDir = fs.mkdtempSync(path.join(homeDir, '.dm-events-redact-test-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-evts-redact-'));
  try {
    const artifactPath = path.join(homeFixtureDir, 'sample.json');
    fs.copyFileSync(FIXTURE_SRC, artifactPath);

    // Sanity: the path must actually start with homedir()
    assert.ok(
      artifactPath.startsWith(homeDir),
      `artifactPath must start with homedir() for this test to be meaningful: ${artifactPath}`
    );

    await harvestArtifact({
      artifactPath,
      sourceKind: 'review-recurring',
      memoryRoot: tmpRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });

    // Read the events JSONL
    const yearMonth = new Date().toISOString().slice(0, 7);
    const eventsFile = path.join(tmpRoot, 'events', yearMonth + '.jsonl');
    assert.ok(fs.existsSync(eventsFile), `events JSONL must exist at ${eventsFile}`);

    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'Should have exactly 1 event line');

    const event = JSON.parse(lines[0]);
    const sourcePath = event.source.path;

    // Must NOT contain the raw home directory path
    assert.ok(
      !sourcePath.includes(homeDir),
      `event source.path must not contain raw home dir. Got: ${JSON.stringify(sourcePath)}`
    );

    // Must have ~/ prefix (redactString replaces homedir() with ~/)
    assert.ok(
      sourcePath.startsWith('~/'),
      `event source.path must start with ~/. Got: ${JSON.stringify(sourcePath)}`
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try { fs.rmSync(homeFixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('events JSONL event_key and other fields (content_hash, run_id) are not redacted', async () => {
  const homeDir = os.homedir();
  const homeFixtureDir = fs.mkdtempSync(path.join(homeDir, '.dm-events-redact-test2-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-evts-redact2-'));
  try {
    const artifactPath = path.join(homeFixtureDir, 'sample.json');
    fs.copyFileSync(FIXTURE_SRC, artifactPath);

    await harvestArtifact({
      artifactPath,
      sourceKind: 'review-recurring',
      memoryRoot: tmpRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });

    const yearMonth = new Date().toISOString().slice(0, 7);
    const eventsFile = path.join(tmpRoot, 'events', yearMonth + '.jsonl');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    const event = JSON.parse(lines[0]);

    // event_key is a sha256 hex — not redacted
    assert.match(event.event_key, /^[a-f0-9]{64}$/, 'event_key must be sha256 hex');
    // source.content_hash not redacted
    assert.match(event.source.content_hash, /^sha256:/, 'content_hash must still be present');
    // source.run_id not redacted
    assert.ok(event.source.run_id, 'run_id must still be present');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try { fs.rmSync(homeFixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
