'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');
const { validateAllCards } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-audit-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

test('validateAllCards: 2 freshly harvested cards pass Ajv strict (post envelope-compat refactor)', async () => {
  const tmp = mkRoot();
  try {
    await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
      sourceKind: 'review-recurring',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    await harvestArtifact({
      artifactPath: path.join(__dirname, 'fixtures/sample-evolve-insights.json'),
      sourceKind: 'evolve-insights',
      memoryRoot: tmp,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    const result = validateAllCards(tmp);
    assert.ok(result.total >= 2, `expected >= 2 cards, got ${result.total}`);
    assert.strictEqual(result.invalid, 0,
      'no schema violations expected: ' + JSON.stringify(result.schema_violations, null, 2));
    assert.strictEqual(result.valid, result.total);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateAllCards: hand-planted invalid card surfaces in schema_violations[]', async () => {
  const tmp = mkRoot();
  try {
    // Plant a structurally broken card — missing required 'payload' field
    const dir = path.join(tmp, 'cards', 'failure-case', 'proj_aaaaaaaaaaaa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mem_broken.json'),
      JSON.stringify({ schema_version: '1.0', envelope: { producer: 'deep-memory' } })
    );
    const result = validateAllCards(tmp);
    assert.strictEqual(result.invalid, 1);
    assert.strictEqual(result.valid, 0);
    assert.ok(result.schema_violations[0].errors.some((e) => /required/.test(e.message)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateAllCards: unparseable JSON file → parse_error report', async () => {
  const tmp = mkRoot();
  try {
    const dir = path.join(tmp, 'cards', 'pattern', 'proj_aaaaaaaaaaaa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mem_corrupt.json'), '{ NOT VALID JSON ');
    const result = validateAllCards(tmp);
    assert.strictEqual(result.invalid, 1);
    assert.ok(result.schema_violations[0].parse_error);
    assert.strictEqual(result.schema_violations[0].memory_id, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateAllCards: empty memory_root returns zeros (no error)', () => {
  const tmp = mkRoot();
  try {
    const result = validateAllCards(tmp);
    assert.deepStrictEqual(result, { total: 0, valid: 0, invalid: 0, schema_violations: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
