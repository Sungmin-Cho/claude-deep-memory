'use strict';
// v0.1.2 — symmetric graceful degradation on the brief/retrieve side. When
// scripts/lib/fts-index.js fails to require (better-sqlite3 native binding
// unavailable in this Node), retrieve must return an empty result + a
// loud, actionable warning. harvest-fts-silent-disable.test.js covers the
// harvest side; this file covers retrieve/brief.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const RETRIEVE_PATH = path.join(REPO_ROOT, 'scripts', 'retrieve.js');
const FTS_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'fts-index.js');

test('graceful degradation — retrieve module loads + runRetrieve returns empty+warning when fts-index require fails', () => {
  const script = `
    'use strict';
    const Module = require('module');

    const ftsPath = ${JSON.stringify(FTS_PATH)};
    const retrievePath = ${JSON.stringify(RETRIEVE_PATH)};

    delete require.cache[ftsPath];
    delete require.cache[retrievePath];

    const os = require('node:os');
    const origLoad = Module._load;
    // v0.1.3 — embed homedir-like substring to exercise redaction path (Codex 🟡 #2).
    const simulatedErr = "Cannot find module '" + os.homedir() + "/.cache/plugin/better-sqlite3.node'";
    Module._load = function(request, parent, isMain) {
      if (request === ftsPath || (parent && Module._resolveFilename(request, parent) === ftsPath)) {
        throw new Error(simulatedErr);
      }
      return origLoad.call(this, request, parent, isMain);
    };

    (async () => {
      try {
        const retrieve = require(retrievePath);
        if (typeof retrieve.runRetrieve !== 'function') {
          process.stderr.write('ERROR: missing runRetrieve\\n');
          process.exit(1);
        }
        const result = await retrieve.runRetrieve({
          task: 'any task',
          memoryRoot: '/tmp/dm-retrieve-degraded',
          projectProfile: { project_id: 'proj_aaaaaaaaaaaa' },
        });
        if (!Array.isArray(result.memories) || result.memories.length !== 0) {
          process.stderr.write('ERROR: expected empty memories[]\\n');
          process.exit(1);
        }
        if (!Array.isArray(result.warnings)) {
          process.stderr.write('ERROR: warnings[] missing\\n');
          process.exit(1);
        }
        const hasDegradedWarning = result.warnings.some(
          (w) => typeof w === 'string' && w.includes('FTS5') && w.includes('better-sqlite3')
        );
        if (!hasDegradedWarning) {
          process.stderr.write('ERROR: degraded warning not present in warnings[]: ' + JSON.stringify(result.warnings) + '\\n');
          process.exit(1);
        }
        // v0.1.3 redaction check — warning must NOT contain literal homedir.
        const homedir = os.homedir();
        const leaked = result.warnings.find((w) => typeof w === 'string' && w.includes(homedir));
        if (leaked) {
          process.stderr.write('ERROR: warning leaked homedir path: ' + leaked + '\\n');
          process.exit(1);
        }
        const hasTilde = result.warnings.some((w) => typeof w === 'string' && w.includes('~/'));
        if (!hasTilde) {
          process.stderr.write('ERROR: warning missing ~/ redaction marker: ' + JSON.stringify(result.warnings) + '\\n');
          process.exit(1);
        }
        process.stdout.write('OK\\n');
        process.exit(0);
      } catch (e) {
        process.stderr.write('ERROR: retrieve threw unexpectedly: ' + e.message + '\\n');
        process.exit(1);
      }
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(result.status, 0, `Child process failed.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes('OK'), `Expected OK in stdout, got: ${result.stdout}`);
});
