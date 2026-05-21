'use strict';
// ITEM-4-r3: harvest.js must NOT silently swallow fts-index load failures.
// When fts-index is loadable (normal CI), the module loads and fts is an object.
// When fts-index fails, harvest throws with a message mentioning 'fts-index' or 'better-sqlite3'.
//
// Because harvest.js throws at require()-time (module scope), we test the failure path
// by spawning a child process that poisons the require cache before requiring harvest.js.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const HARVEST_PATH = path.join(REPO_ROOT, 'scripts', 'harvest.js');
const FTS_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'fts-index.js');

test('ITEM-4-r3: happy path — harvest module loads without error when fts-index is available', () => {
  // Verify that in normal CI (better-sqlite3 installed), the module-scope require succeeds.
  const harvest = require('../scripts/harvest');
  assert.ok(harvest, 'harvest module must load without throwing');
  assert.strictEqual(typeof harvest.harvestArtifact, 'function', 'harvestArtifact must be exported');
});

test('ITEM-4-r3: failure path — if fts-index throws on require, harvest throws with descriptive message', () => {
  // Spawn a child that deletes the fts-index cache entry and replaces it with a module
  // that throws, then tries to require harvest.js (which will also need its cache cleared).
  // Use absolute paths throughout since spawnSync runs in project root.
  const script = `
    'use strict';
    const path = require('path');
    const Module = require('module');

    const ftsPath = ${JSON.stringify(FTS_PATH)};
    const harvestPath = ${JSON.stringify(HARVEST_PATH)};

    // Clear any cached versions so they re-execute
    delete require.cache[ftsPath];
    delete require.cache[harvestPath];

    // Inject a poisoned module for fts-index that throws on require
    const fakeMod = new Module(ftsPath, null);
    fakeMod.filename = ftsPath;
    fakeMod.loaded = true;
    // Override Module._load for fts-index specifically
    const origLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === ftsPath || (parent && Module._resolveFilename(request, parent) === ftsPath)) {
        throw new Error('simulated fts-index load failure (native build missing)');
      }
      return origLoad.call(this, request, parent, isMain);
    };

    try {
      require(harvestPath);
      process.stderr.write('ERROR: harvest should have thrown but did not\\n');
      process.exit(1);
    } catch (e) {
      if (!e.message.includes('fts-index') && !e.message.includes('better-sqlite3')) {
        process.stderr.write('ERROR: thrown message does not mention fts-index or better-sqlite3: ' + e.message + '\\n');
        process.exit(1);
      }
      process.stdout.write('OK: ' + e.message.slice(0, 80) + '\\n');
      process.exit(0);
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

test('ITEM-4-r3: error message template mentions fts-index and better-sqlite3', () => {
  // Documentation-grade: verify the exact error message strings are present in the source.
  const src = fs.readFileSync(HARVEST_PATH, 'utf8');
  assert.ok(
    src.includes('fts-index.js + better-sqlite3 to be loadable'),
    'harvest.js must contain the descriptive error message'
  );
  assert.ok(
    src.includes('throw new Error('),
    'harvest.js must throw (not just log) on fts-index load failure'
  );
  // Verify the silent-disable pattern is gone
  assert.ok(
    !src.includes('catch { /* Phase 4 wires this */ }'),
    'The silent-disable catch comment must be removed'
  );
});
