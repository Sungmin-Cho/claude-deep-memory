'use strict';
// ITEM-5-r4: FTS5 MATCH implicit AND → OR so multi-token natural-language tasks
// that contain tokens not all present in indexed text still return results.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, search, closeIndex } = require('../scripts/lib/fts-index');

function mkTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-or-'));
  return {
    tmp,
    dbPath: path.join(tmp, 'lexical.sqlite'),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function plantCard(idx, { memoryId, claim, tags = [], keywords = [] }) {
  upsertCard(idx, {
    payload: {
      memory_id: memoryId,
      memory_type: 'failure-case',
      privacy_level: 'global',
      claim,
      tags,
      applicability: [],
      search_keywords: keywords,
    },
  });
}

test('ITEM-5: search("fix codex skill bug") returns non-empty — OR semantics match via codex/skill', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    plantCard(idx, {
      memoryId: 'mem_codex',
      claim: 'codex skill discovery silently fails',
      tags: ['codex', 'skill'],
    });
    // Multi-token query where "fix" and "bug" do not appear in card — AND would return 0
    const rows = search(idx, 'fix codex skill bug', { topN: 5 });
    assert.ok(rows.length > 0, `Expected results for 'fix codex skill bug' with OR, got 0`);
    assert.strictEqual(rows[0].memory_id, 'mem_codex', 'matching card via codex/skill tokens');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('ITEM-5: search("codex skill") returns non-empty (back-compat — two tokens)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    plantCard(idx, {
      memoryId: 'mem_codex',
      claim: 'codex skill discovery silently fails',
      tags: ['codex', 'skill'],
    });
    const rows = search(idx, 'codex skill', { topN: 5 });
    assert.ok(rows.length > 0, `Expected results for 'codex skill', got 0`);
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('ITEM-5: search("__no_match_sentinel__") returns no spurious match', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    plantCard(idx, {
      memoryId: 'mem_codex',
      claim: 'codex skill',
      tags: [],
    });
    const rows = search(idx, '__no_match_sentinel__', { topN: 5 });
    assert.strictEqual(rows.length, 0, 'sentinel query must not match any card');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('ITEM-5: empty query still returns [] (sentinel path unchanged)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    plantCard(idx, {
      memoryId: 'mem_any',
      claim: 'codex',
      tags: [],
    });
    const rows = search(idx, '', { topN: 5 });
    assert.deepStrictEqual(rows, [], 'empty query must return empty array');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('ITEM-5: single-token query still works (no OR introduced for 1 token)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    plantCard(idx, {
      memoryId: 'mem_single',
      claim: 'typescript strict mode enforcement',
      tags: ['typescript'],
    });
    const rows = search(idx, 'typescript', { topN: 5 });
    assert.ok(rows.length > 0, 'single-token query must still return results');
    assert.strictEqual(rows[0].memory_id, 'mem_single');
  } finally {
    closeIndex(idx);
    cleanup();
  }
});
