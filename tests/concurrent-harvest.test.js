'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact, eventKey, buildSourceMeta } = require('../scripts/harvest');

const FIXTURE = path.join(__dirname, 'fixtures/sample-recurring-findings.json');

function eventsFileFor(memoryRoot) {
  return path.join(memoryRoot, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
}

function readEventLines(memoryRoot) {
  const f = eventsFileFor(memoryRoot);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
}

test('R3 P3: sequential re-harvest of same artifact stays at 1 event line (idempotent event_key)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conc-'));
  const opts = {
    artifactPath: FIXTURE,
    sourceKind: 'review-recurring',
    memoryRoot: tmp,
    projectId: 'proj_aaaaaaaaaaaa',
    skipDistillStepB: true,
  };
  try {
    await harvestArtifact(opts);
    await harvestArtifact(opts);
    await harvestArtifact(opts);
    const lines = readEventLines(tmp);
    assert.strictEqual(lines.length, 1, `expected 1 idempotent event, got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.match(parsed.event_key, /^[a-f0-9]{64}$/);
    assert.strictEqual(parsed.project_id, 'proj_aaaaaaaaaaaa');
    assert.strictEqual(parsed.cards_count, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R3 P3: concurrent harvest of same project is fenced by lease (one succeeds, other rejects)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conc-'));
  const opts = {
    artifactPath: FIXTURE,
    sourceKind: 'review-recurring',
    memoryRoot: tmp,
    projectId: 'proj_aaaaaaaaaaaa',
    skipDistillStepB: true,
  };
  try {
    const results = await Promise.allSettled([harvestArtifact(opts), harvestArtifact(opts)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.strictEqual(fulfilled.length, 1, 'exactly one concurrent harvest must win the lease');
    assert.strictEqual(rejected.length, 1, 'exactly one concurrent harvest must lose the lease');
    assert.match(rejected[0].reason.message, /Another session already harvesting/);
    // single event line written by the winner
    const lines = readEventLines(tmp);
    assert.strictEqual(lines.length, 1);
    // lease cleaned up by winner's finally
    assert.ok(!fs.existsSync(path.join(tmp, '.leases', 'proj_aaaaaaaaaaaa.lease')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('eventKey changes with content_hash (re-harvest after artifact edit creates new event)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conc-'));
  const fixtureCopy = path.join(tmp, 'fixture.json');
  fs.copyFileSync(FIXTURE, fixtureCopy);
  const opts = {
    artifactPath: fixtureCopy,
    sourceKind: 'review-recurring',
    memoryRoot: tmp,
    projectId: 'proj_aaaaaaaaaaaa',
    skipDistillStepB: true,
  };
  try {
    await harvestArtifact(opts);
    // mutate the fixture — adds new finding → content_hash changes → new event_key
    const raw = JSON.parse(fs.readFileSync(fixtureCopy, 'utf8'));
    raw.payload.findings.push({
      title: 'Second valid finding after artifact edit',
      category: 'edit',
      first_seen: '2026-05-19T00:00:00Z',
      evidence: ['mutated fixture'],
      tags: ['edit'],
    });
    fs.writeFileSync(fixtureCopy, JSON.stringify(raw));
    await harvestArtifact(opts);
    const lines = readEventLines(tmp);
    assert.strictEqual(lines.length, 2, 'distinct event lines on artifact mutation');
    const keys = lines.map((l) => JSON.parse(l).event_key);
    assert.notStrictEqual(keys[0], keys[1]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('eventKey is pure: same source-meta yields same hex digest', () => {
  const meta = {
    id: 'src_0',
    path: '/tmp/x.json',
    content_hash: 'sha256:abc',
    captured_at: '2026-05-20T00:00:00Z',
    artifact_kind: 'recurring-findings',
    schema_version: '1.0',
    run_id: 'run_xyz',
  };
  const a = eventKey(meta);
  const b = eventKey(meta);
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  const c = eventKey({ ...meta, run_id: 'run_other' });
  assert.notStrictEqual(a, c);
});

test('buildSourceMeta exposes content_hash + run_id (consumed by eventKey)', () => {
  const meta = buildSourceMeta(
    FIXTURE,
    JSON.parse(fs.readFileSync(FIXTURE, 'utf8')),
    'review-recurring'
  );
  assert.match(meta.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(meta.artifact_kind, 'recurring-findings');
  assert.strictEqual(meta.run_id, '01j_recur_fixture_0001');
});
