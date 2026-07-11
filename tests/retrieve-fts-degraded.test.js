'use strict';
// When the optional native SQLite driver cannot load, CLI retrieval must still
// run the ordinary Stage 1–8 pipeline over the bounded privacy-scoped card scan.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const RETRIEVE_PATH = path.join(REPO_ROOT, 'scripts', 'retrieve.js');
const FTS_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'fts-index.js');

test('graceful degradation preserves Stage 1–8 over card-scan fallback', (t) => {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-retrieve degraded Ω '));
  t.after(() => fs.rmSync(memoryRoot, { recursive: true, force: true }));
  const projectId = 'proj_aaaaaaaaaaaa';
  const cardDir = path.join(memoryRoot, 'cards', 'pattern', projectId);
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, 'mem_fallback.json'), JSON.stringify({
    memory_id: 'mem_fallback',
    memory_type: 'pattern',
    privacy_level: 'local',
    project_id: projectId,
    claim: 'retry with bounded exponential backoff',
    status: 'active',
    tags: ['retry'],
    applicability: [],
    non_applicability: [],
    search_keywords: ['backoff'],
    confidence: 0.9,
    evidence_summary: [],
  }));

  const script = `
    'use strict';
    const Module = require('module');
    const os = require('node:os');

    const ftsPath = ${JSON.stringify(FTS_PATH)};
    const retrievePath = ${JSON.stringify(RETRIEVE_PATH)};
    delete require.cache[ftsPath];
    delete require.cache[retrievePath];

    const origLoad = Module._load;
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
          task: 'retry backoff',
          memoryRoot: ${JSON.stringify(memoryRoot)},
          projectProfile: { project_id: ${JSON.stringify(projectId)}, signature: { languages: [] } },
        });
        if (!Array.isArray(result.memories) || result.memories.length !== 1 ||
            result.memories[0].payload.memory_id !== 'mem_fallback') {
          process.stderr.write('ERROR: expected card-scan memory: ' + JSON.stringify(result.memories) + '\\n');
          process.exit(1);
        }
        if (!Array.isArray(result.warnings) || !result.warnings.includes('lexical_stream_fallback')) {
          process.stderr.write('ERROR: fallback warning missing: ' + JSON.stringify(result.warnings) + '\\n');
          process.exit(1);
        }
        const homedir = os.homedir();
        const leaked = result.warnings.find((warning) => typeof warning === 'string' && warning.includes(homedir));
        if (leaked) {
          process.stderr.write('ERROR: warning leaked homedir path: ' + leaked + '\\n');
          process.exit(1);
        }
        process.stdout.write('OK\\n');
      } catch (error) {
        process.stderr.write('ERROR: retrieve threw unexpectedly: ' + error.message + '\\n');
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
