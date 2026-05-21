'use strict';
// v0.1.2 — FTS5 graceful degradation. v0.1.0 round-5 made harvest hard-throw
// when scripts/lib/fts-index.js failed to require (better-sqlite3 native
// binding unavailable). That posture was wrong for Node v26+ environments
// where the plugin cache is immutable and the user can't fix the build.
//
// v0.1.2 reverses to graceful degradation: harvest writes cards/events to
// disk, FTS5 upsert is skipped, and an explicit warning surfaces via
// `cards.warnings`. brief returns empty + same warning. sql.js WASM fallback
// is deferred to v0.2.0 (handoff-phase-4-6.md).
//
// These tests verify the new (graceful) behavior, NOT the old hard-throw.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const HARVEST_PATH = path.join(REPO_ROOT, 'scripts', 'harvest.js');
const FTS_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'fts-index.js');

test('happy path — harvest module loads without error when fts-index is available', () => {
  const harvest = require('../scripts/harvest');
  assert.ok(harvest, 'harvest module must load without throwing');
  assert.strictEqual(typeof harvest.harvestArtifact, 'function', 'harvestArtifact must be exported');
  assert.strictEqual(typeof harvest.isFtsAvailable, 'function', 'isFtsAvailable probe must be exported');
  assert.strictEqual(harvest.isFtsAvailable(), true, 'fts must be available in normal CI');
});

test('graceful degradation — when fts-index require fails, harvest module STILL loads (no throw)', () => {
  // Spawn a child that poisons fts-index require, then loads harvest.js.
  // Pre-v0.1.2: harvest threw at module scope.
  // Post-v0.1.2: harvest loads OK; isFtsAvailable() returns false.
  const script = `
    'use strict';
    const Module = require('module');

    const ftsPath = ${JSON.stringify(FTS_PATH)};
    const harvestPath = ${JSON.stringify(HARVEST_PATH)};

    delete require.cache[ftsPath];
    delete require.cache[harvestPath];

    const origLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === ftsPath || (parent && Module._resolveFilename(request, parent) === ftsPath)) {
        throw new Error('simulated fts-index load failure (native build missing)');
      }
      return origLoad.call(this, request, parent, isMain);
    };

    try {
      const harvest = require(harvestPath);
      if (typeof harvest.harvestArtifact !== 'function') {
        process.stderr.write('ERROR: harvest module loaded but missing harvestArtifact\\n');
        process.exit(1);
      }
      if (typeof harvest.isFtsAvailable !== 'function') {
        process.stderr.write('ERROR: harvest module missing isFtsAvailable probe\\n');
        process.exit(1);
      }
      if (harvest.isFtsAvailable() !== false) {
        process.stderr.write('ERROR: isFtsAvailable should return false when fts-index unloadable\\n');
        process.exit(1);
      }
      // Verify the degraded-warning constant is exported and mentions the user-actionable fix.
      if (!harvest.FTS_DEGRADED_WARNING || !harvest.FTS_DEGRADED_WARNING.includes('better-sqlite3')) {
        process.stderr.write('ERROR: FTS_DEGRADED_WARNING missing or unhelpful\\n');
        process.exit(1);
      }
      process.stdout.write('OK\\n');
      process.exit(0);
    } catch (e) {
      process.stderr.write('ERROR: harvest threw unexpectedly: ' + e.message + '\\n');
      process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(result.status, 0, `Child process failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes('OK'), `Expected OK in stdout, got: ${result.stdout}`);
});

test('FTS_DEGRADED_WARNING constant is informative and actionable', () => {
  const harvest = require('../scripts/harvest');
  const w = harvest.FTS_DEGRADED_WARNING;
  assert.strictEqual(typeof w, 'string');
  assert.ok(w.includes('FTS5'), 'warning must mention FTS5');
  assert.ok(w.includes('better-sqlite3'), 'warning must mention better-sqlite3 (the cause)');
  assert.ok(w.includes('harvest continues'), 'warning must reassure that harvest write succeeded');
  assert.ok(w.includes('Troubleshooting') || w.includes('README'), 'warning must point to docs');
});

test('source verification — harvest.js no longer hard-throws on fts-index require failure', () => {
  // Documentation-grade: verify the hard-throw was reversed.
  const src = fs.readFileSync(HARVEST_PATH, 'utf8');
  assert.ok(
    !src.includes(
      "throw new Error(\n    'deep-memory harvest requires scripts/lib/fts-index.js + better-sqlite3 to be loadable. ' +"
    ),
    'round-5 ITEM-4 hard-throw must be reversed in v0.1.2'
  );
  assert.ok(
    src.includes('graceful degradation') || src.includes('FTS_DEGRADED_WARNING'),
    'harvest.js must reference the graceful-degradation path'
  );
});
