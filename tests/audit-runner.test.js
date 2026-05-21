'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { run: runAudit, resolveMemoryRoot } = require('../scripts/audit');

function setup() {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-aud-mem-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-aud-proj-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(memoryRoot, sub), { recursive: true });
  }
  return {
    memoryRoot,
    projectDir,
    cleanup: () => {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

test('Task 5.8: run() aggregates 6 sub-results and atomic-writes latest-audit.json', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    const result = await runAudit({ memoryRoot, projectDir });
    assert.ok(result.summary);
    assert.strictEqual(typeof result.summary.total_cards, 'number');
    assert.strictEqual(typeof result.summary.issues, 'number');
    assert.strictEqual(typeof result.summary.auto_fixed, 'number');
    assert.ok(result.schema);
    assert.ok(result.transitions);
    assert.ok(result.stale_locks);
    assert.ok(result.dedupe);
    assert.ok(result.source_renames);
    assert.ok(result.profile);
    const written = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.deep-memory/latest-audit.json'), 'utf8')
    );
    assert.strictEqual(written.summary.total_cards, result.summary.total_cards);
  } finally {
    cleanup();
  }
});

test('Task 5.8: run() with empty memory_root produces zero issues + writes report', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    const result = await runAudit({ memoryRoot, projectDir });
    assert.strictEqual(result.summary.total_cards, 0);
    assert.strictEqual(result.summary.issues, 0);
    assert.strictEqual(result.summary.auto_fixed, 0);
    assert.ok(fs.existsSync(path.join(projectDir, '.deep-memory/latest-audit.json')));
  } finally {
    cleanup();
  }
});

test('Task 5.8: run() requires memoryRoot', async () => {
  await assert.rejects(() => runAudit({}), /requires memoryRoot/);
});

test('Task 5.8: resolveMemoryRoot honors env + ~ + arg precedence', () => {
  const orig = process.env.DEEP_MEMORY_ROOT;
  try {
    delete process.env.DEEP_MEMORY_ROOT;
    assert.strictEqual(resolveMemoryRoot('~/foo'), path.join(os.homedir(), 'foo'));
    process.env.DEEP_MEMORY_ROOT = '/tmp/env-aud';
    assert.strictEqual(resolveMemoryRoot(), '/tmp/env-aud');
    assert.strictEqual(resolveMemoryRoot('/tmp/explicit'), '/tmp/explicit');
  } finally {
    if (orig === undefined) delete process.env.DEEP_MEMORY_ROOT;
    else process.env.DEEP_MEMORY_ROOT = orig;
  }
});

test('Task 5.8: issues aggregate across sub-feature results (corrupted card surfaces in schema)', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    // plant a structurally broken card
    const dir = path.join(memoryRoot, 'cards', 'pattern', 'proj_aaaaaaaaaaaa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mem_broken.json'), '{ NOT JSON');
    const result = await runAudit({ memoryRoot, projectDir });
    assert.ok(result.summary.issues >= 1);
    assert.ok(result.schema.invalid >= 1);
  } finally {
    cleanup();
  }
});
