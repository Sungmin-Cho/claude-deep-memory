'use strict';
// ITEM-2-r5: quarantine write must redact sourceMeta.path — symmetric with round-1 ITEM-2 (cards)
// and round-4 ITEM-4 (events JSONL). Home dir must never appear in any deep-memory output file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Build a minimal recurring-findings fixture where ALL findings have empty evidence.
 * This forces every draft to fail F1 → quarantineEmptyClaim is triggered with an
 * artifactPath that lives under os.homedir() (spoofed via tmp dir placed under HOME).
 */
function buildAllEmptyFixture() {
  return {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope: {
      producer: 'deep-review',
      producer_version: '1.0.0',
      artifact_kind: 'recurring-findings',
      run_id: 'quarantine_redact_test_001',
      generated_at: new Date().toISOString(),
      schema: { name: 'recurring-findings', version: '1.0' },
      provenance: { source_artifacts: [], tool_versions: { node: process.version } },
    },
    payload: {
      findings: [
        {
          title: 'Finding with empty evidence — forces F1 quarantine',
          category: 'quality',
          first_seen: new Date().toISOString(),
          evidence: [],  // F1 violation: empty evidence_summary
          tags: [],
        },
      ],
    },
  };
}

test('ITEM-2-r5: quarantine file source.path is redacted — home dir does not appear', async () => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quar-root-'));
  // Place the fixture file under a path that simulates a home-directory path.
  // Use os.homedir() itself — create a tmp subdir under it.
  const homeSubDir = fs.mkdtempSync(path.join(os.homedir(), '.dm-quar-test-'));
  const artifactPath = path.join(homeSubDir, 'quarantine-test-fixture.json');
  try {
    fs.writeFileSync(artifactPath, JSON.stringify(buildAllEmptyFixture()));
    // Harvest — all findings have empty evidence so all fail F1 → quarantine fires.
    // skipDistillStepB: true for speed; Step B doesn't affect F1 path.
    await harvestArtifact({
      artifactPath,
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // Locate the quarantine file — named <run_id>.json
    const quarDir = path.join(memoryRoot, '.quarantine', 'empty-claim');
    assert.ok(fs.existsSync(quarDir), `Quarantine dir not found at ${quarDir}`);
    const quarFiles = fs.readdirSync(quarDir).filter((f) => f.endsWith('.json'));
    assert.ok(quarFiles.length > 0, 'Expected at least one quarantine file');
    const quarContent = JSON.parse(fs.readFileSync(path.join(quarDir, quarFiles[0]), 'utf8'));

    // Assert the path is redacted: must start with ~/ and must NOT contain os.homedir()
    const sourcePath = quarContent.source?.path;
    assert.ok(typeof sourcePath === 'string', `source.path must be a string, got ${typeof sourcePath}`);
    assert.ok(
      sourcePath.startsWith('~/'),
      `source.path must start with ~/ after redaction, got: ${sourcePath}`
    );
    assert.ok(
      !sourcePath.includes(os.homedir()),
      `source.path must NOT contain os.homedir() (${os.homedir()}), got: ${sourcePath}`
    );
  } finally {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
    try { fs.rmSync(homeSubDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('ITEM-2-r5: harvest-golden quarantine still fires with redacted path (back-compat)', async () => {
  // Verify the existing fixture (sample-recurring-findings.json) still triggers quarantine
  // for its empty-evidence finding AND that quarantine file has redacted path.
  // The fixture path is under REPO_ROOT (not under HOME), so redactString may leave it as-is
  // (no home-dir prefix to redact). This just verifies the quarantine file is STILL written
  // (the redaction change must not break the quarantine flow).
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quar-golden-'));
  const fixture = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-recurring-findings.json');
  try {
    const cards = await harvestArtifact({
      artifactPath: fixture,
      sourceKind: 'review-recurring',
      memoryRoot,
      projectId: 'proj_aaaaaaaaaaaa',
      skipDistillStepB: true,
    });
    // F1: fixture has 1 valid finding + 1 empty-evidence → 1 card + 1 quarantined
    assert.strictEqual(cards.length, 1, 'F1 must filter the empty-evidence finding');
    const quarDir = path.join(memoryRoot, '.quarantine', 'empty-claim');
    assert.ok(fs.existsSync(quarDir), 'Quarantine dir must still exist after redaction change');
    const quarFiles = fs.readdirSync(quarDir).filter((f) => f.endsWith('.json'));
    assert.ok(quarFiles.length > 0, 'Quarantine file must still be written for F1-failing finding');
    const quarContent = JSON.parse(fs.readFileSync(path.join(quarDir, quarFiles[0]), 'utf8'));
    // source.path must be a string (possibly ~ if fixture is under home, else just path — redactString
    // only transforms home-dir substrings, so non-home paths pass through unchanged)
    assert.ok(typeof quarContent.source?.path === 'string', 'source.path must be a string');
    assert.ok(
      !quarContent.source.path.includes(os.homedir()),
      `source.path must not contain literal homedir. got: ${quarContent.source.path}`
    );
    // rejected_count must reflect the 1 rejected draft
    assert.strictEqual(quarContent.rejected_count, 1, 'rejected_count should be 1');
  } finally {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
  }
});
