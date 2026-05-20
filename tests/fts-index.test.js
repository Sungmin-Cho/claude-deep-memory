'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, search, closeIndex, sanitizeQuery, DRIVER_NAME } = require('../scripts/lib/fts-index');

function mkTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-'));
  return {
    tmp,
    dbPath: path.join(tmp, 'lexical.sqlite'),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('upsert + search returns BM25-ranked rows (codex/skill/yaml term match)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_a',
        memory_type: 'failure-case',
        privacy_level: 'global',
        claim: 'Codex skill discovery fails on invalid YAML',
        tags: ['codex', 'skill'],
        applicability: [{ value: 'plugin migration' }],
        search_keywords: ['frontmatter', 'yaml'],
      },
    });
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_b',
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: 'Use TypeScript strict mode',
        tags: ['typescript'],
        applicability: [{ value: 'frontend' }],
        search_keywords: [],
      },
    });
    const rows = search(idx, 'codex skill yaml', { topN: 5 });
    assert.ok(rows.length >= 1);
    assert.strictEqual(rows[0].memory_id, 'mem_a');
    assert.ok('bm25' in rows[0], 'rows expose bm25 column for downstream normalization');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('privacy scope: local card visible only to matching project_id', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_local',
        memory_type: 'failure-case',
        privacy_level: 'local',
        claim: 'project-local card about codex',
        tags: ['codex'],
        applicability: [],
        search_keywords: [],
      },
    }, { projectId: 'proj_A' });
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_global',
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: 'global card about codex',
        tags: ['codex'],
        applicability: [],
        search_keywords: [],
      },
    }, { projectId: '' });

    // proj_A sees both
    const proj_A = search(idx, 'codex', { topN: 10, projectId: 'proj_A' });
    const idsA = proj_A.map((r) => r.memory_id).sort();
    assert.deepStrictEqual(idsA, ['mem_global', 'mem_local']);

    // proj_B sees only global
    const proj_B = search(idx, 'codex', { topN: 10, projectId: 'proj_B' });
    const idsB = proj_B.map((r) => r.memory_id);
    assert.deepStrictEqual(idsB, ['mem_global'], 'local card from proj_A invisible to proj_B');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('upsertCard is idempotent (re-insert same memory_id replaces row)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_x',
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: 'first claim',
        tags: [],
        applicability: [],
        search_keywords: [],
      },
    });
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_x',
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: 'updated claim text',
        tags: [],
        applicability: [],
        search_keywords: [],
      },
    });
    const rows = search(idx, 'updated', { topN: 5 });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].memory_id, 'mem_x');
    assert.ok(rows[0].claim.includes('updated'));
    const rowsOld = search(idx, 'first', { topN: 5 });
    assert.strictEqual(rowsOld.length, 0, 'old claim no longer matches after replace');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('search returns [] on empty query (sanitizeQuery sentinel)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    upsertCard(idx, {
      payload: {
        memory_id: 'mem_a',
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: 'codex',
        tags: [],
        applicability: [],
        search_keywords: [],
      },
    });
    const rows = search(idx, '', { topN: 5 });
    assert.deepStrictEqual(rows, []);
    const rows2 = search(idx, '   :: ', { topN: 5 });
    assert.deepStrictEqual(rows2, []);
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('sanitizeQuery handles FTS5 syntax characters', () => {
  assert.strictEqual(sanitizeQuery('codex: "skill"'), 'codex skill');
  assert.strictEqual(sanitizeQuery('foo-bar / baz'), 'foo bar baz');
  assert.strictEqual(sanitizeQuery(''), '__no_match_sentinel__');
  assert.strictEqual(sanitizeQuery(null), '__no_match_sentinel__');
});

test('DRIVER_NAME constant exposes the active driver for diagnostic logging', () => {
  assert.strictEqual(DRIVER_NAME, 'better-sqlite3');
});

test('overfetch: search returns up to topN × 3 rows (Stage 0 headroom)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    for (let i = 0; i < 12; i++) {
      upsertCard(idx, {
        payload: {
          memory_id: 'mem_' + i,
          memory_type: 'pattern',
          privacy_level: 'global',
          claim: 'common codex term ' + i,
          tags: ['codex'],
          applicability: [],
          search_keywords: [],
        },
      });
    }
    const rows = search(idx, 'codex', { topN: 3 });
    assert.ok(rows.length >= 3 && rows.length <= 9, `expected 3..9 rows for topN=3, got ${rows.length}`);
  } finally {
    closeIndex(idx);
    cleanup();
  }
});
