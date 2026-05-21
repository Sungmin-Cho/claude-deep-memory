'use strict';
// ITEM-1-r5: harvest CLI runner must fail-closed when profile.project_id != deriveProjectId(cwd).
// Writes are fail-closed (unlike brief.js reads which fall back softly).
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..');
const HARVEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'harvest.js');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-recurring-findings.json');

test('ITEM-1-r5: spoofed profile (mismatched project_id) → exit 1 + stderr contains "project-profile mismatch"', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-root-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-proj-'));
  try {
    // Write a profile with a project_id that will NOT match deriveProjectId(tmpProject).
    // A static well-formed but wrong project_id is sufficient.
    const fakeProfile = {
      project_id: 'proj_000000000000',   // 12 hex chars — passes validateProjectId
      generated_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(tmpProject, '.deep-memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.deep-memory', 'project-profile.json'),
      JSON.stringify(fakeProfile)
    );

    const result = spawnSync(
      process.execPath,
      [HARVEST_SCRIPT, FIXTURE, '--kind', 'review-recurring'],
      {
        cwd: tmpProject,
        env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    assert.strictEqual(result.status, 1,
      `Expected exit 1 for mismatched profile, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /project-profile mismatch/,
      `Expected "project-profile mismatch" in stderr, got: ${result.stderr}`);
    // latest-harvest.json must NOT have been written
    const harvestPath = path.join(tmpProject, '.deep-memory', 'latest-harvest.json');
    assert.ok(!fs.existsSync(harvestPath), 'latest-harvest.json must NOT be written on mismatch');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('ITEM-1-r5: --project explicit flag overrides profile check → exit 0 (guard only applies to profile-derived id)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-root2-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-proj2-'));
  try {
    // Spoofed profile — would fail without --project
    const fakeProfile = {
      project_id: 'proj_000000000000',
      generated_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(tmpProject, '.deep-memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.deep-memory', 'project-profile.json'),
      JSON.stringify(fakeProfile)
    );

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
    // --project explicit wins → guard skipped → exit 0
    assert.strictEqual(result.status, 0,
      `Expected exit 0 when --project is explicit, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const harvestPath = path.join(tmpProject, '.deep-memory', 'latest-harvest.json');
    assert.ok(fs.existsSync(harvestPath), 'latest-harvest.json must be written when --project is explicit');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('ITEM-1-r5: matching profile (project_id == deriveProjectId(cwd)) → exit 0 + latest-harvest.json written', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-root3-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgrd-proj3-'));
  try {
    // Derive the correct project_id for tmpProject by calling the same init.js helper.
    // Use fs.realpathSync so the cwd path matches what process.cwd() returns in the child
    // process (on macOS, /var/folders/... is a symlink; process.cwd() resolves to
    // /private/var/folders/... which is a different string and would change the hash).
    const { projectId: deriveProjectId } = require('../scripts/init');
    const correctId = deriveProjectId(fs.realpathSync(tmpProject));

    const matchingProfile = {
      project_id: correctId,
      generated_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(tmpProject, '.deep-memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.deep-memory', 'project-profile.json'),
      JSON.stringify(matchingProfile)
    );

    const result = spawnSync(
      process.execPath,
      [HARVEST_SCRIPT, FIXTURE, '--kind', 'review-recurring'],
      {
        cwd: tmpProject,
        env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    assert.strictEqual(result.status, 0,
      `Expected exit 0 for matching profile, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const harvestPath = path.join(tmpProject, '.deep-memory', 'latest-harvest.json');
    assert.ok(fs.existsSync(harvestPath), 'latest-harvest.json must be written on match');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});
