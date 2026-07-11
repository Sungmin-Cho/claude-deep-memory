'use strict';
// Unit tests for the MCP read-tool FTS wiring (scripts/lib/mcp-fts-search.js).
// Pre-fix the MCP server passed `ftsSearch: null`, making lexical retrieval a
// silent no-op; makeFtsSearch resolves the real lexical index and degrades
// gracefully when the index is absent.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFtsSearch } = require('../scripts/lib/mcp-fts-search');

let fts = null;
try { fts = require('../scripts/lib/fts-index'); } catch { /* driver unavailable */ }

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-fts-'));
}

test('makeFtsSearch: returns [] (no DB file created) when the index does not exist yet', () => {
  const root = mkRoot();
  const search = makeFtsSearch(root);
  const rows = search({ query: 'anything', currentProjectId: 'proj_a', topK: 10 });
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(
    fs.existsSync(path.join(root, 'indexes', 'v2', 'lexical.sqlite')),
    false,
    'must not create an empty sqlite file for a project that never harvested'
  );
});

test('makeFtsSearch: queries the real lexical index and returns matching card rows', { skip: !fts }, () => {
  const root = mkRoot();
  const dbPath = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
  const idx = fts.openIndex(dbPath);
  fts.upsertCard(idx, {
    memory_id: 'mem_pattern_abc',
    memory_type: 'pattern',
    privacy_level: 'local',
    project_id: 'proj_a',
    claim: 'retry the flaky network call with exponential backoff',
    tags: ['network', 'retry'],
    applicability: [],
    search_keywords: ['backoff', 'retry']
  }, { projectId: 'proj_a' });
  fts.closeIndex(idx);

  const search = makeFtsSearch(root);
  const rows = search({ query: 'retry backoff', currentProjectId: 'proj_a', topK: 10 });
  assert.ok(Array.isArray(rows) && rows.length >= 1, `expected >=1 row, got ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].memory_id, 'mem_pattern_abc');
  assert.strictEqual(rows[0].project_id, 'proj_a');
  // The row carries claim text so the fused result is useful, not just an id.
  assert.match(rows[0].claim, /backoff/);
});

test('makeFtsSearch: native-loader failure message is redacted before it can reach MCP warnings', () => {
  const root = mkRoot();
  const search = makeFtsSearch(root, {
    loadFts: () => {
      throw new Error(
        "Cannot find module '/Users/jane/Library/pnpm/better-sqlite3/build/Release/better_sqlite3.node'"
      );
    }
  });
  assert.throws(
    () => search({ query: 'anything', currentProjectId: 'proj_a', topK: 10 }),
    (e) => {
      assert.match(e.message, /FTS5 lexical index unavailable/);
      assert.ok(
        !e.message.includes('/Users/'),
        `absolute home path must be redacted, got: ${e.message}`
      );
      return true;
    }
  );
});

test('makeFtsSearch: redacted loader error propagates redacted through runHybridRetrieve warnings', async () => {
  const { runHybridRetrieve } = require('../scripts/lib/retrieve-hybrid');
  const root = mkRoot();
  const search = makeFtsSearch(root, {
    loadFts: () => {
      throw new Error(
        "Cannot find module '/Users/jane/Library/pnpm/better-sqlite3/build/Release/better_sqlite3.node'"
      );
    }
  });
  const result = await runHybridRetrieve({
    query: 'anything',
    currentProjectId: 'proj_a',
    root,
    ftsSearch: search,
    topN: 5
  });
  const ftsWarnings = (result.warnings || []).filter((w) => w.startsWith('fts_stream_error:'));
  assert.ok(ftsWarnings.length >= 1, `expected an fts_stream_error warning, got: ${JSON.stringify(result.warnings)}`);
  for (const w of ftsWarnings) {
    assert.ok(!w.includes('/Users/'), `MCP-bound warning must not leak absolute paths, got: ${w}`);
  }
});

test('makeFtsSearch: privacy scope — a different project sees only global cards', { skip: !fts }, () => {
  const root = mkRoot();
  const dbPath = path.join(root, 'indexes', 'v2', 'lexical.sqlite');
  const idx = fts.openIndex(dbPath);
  fts.upsertCard(idx, {
    memory_id: 'mem_local_a', memory_type: 'pattern', privacy_level: 'local',
    project_id: 'proj_a', claim: 'proj a local secret pattern', tags: [], applicability: [], search_keywords: []
  }, { projectId: 'proj_a' });
  fts.closeIndex(idx);

  const search = makeFtsSearch(root);
  const rows = search({ query: 'secret pattern', currentProjectId: 'proj_b', topK: 10 });
  assert.deepStrictEqual(rows, [], 'proj_b must not see proj_a local cards');
});
