'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, search, closeIndex, sanitizeQuery } = require('../scripts/lib/fts-index');

function mkTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-unicode-'));
  return {
    tmp,
    dbPath: path.join(tmp, 'lexical.sqlite'),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('ITEM-7-r2: sanitizeQuery preserves Korean (Hangul) characters', () => {
  const result = sanitizeQuery('메모리 회상');
  assert.notStrictEqual(result, '__no_match_sentinel__', 'Korean query must not degrade to sentinel');
  assert.ok(result.includes('메모리'), `expected "메모리" in sanitized result: ${result}`);
  assert.ok(result.includes('회상'), `expected "회상" in sanitized result: ${result}`);
});

test('ITEM-7-r2: sanitizeQuery preserves CJK Unified Ideographs (Chinese)', () => {
  const result = sanitizeQuery('内存 检索');
  assert.notStrictEqual(result, '__no_match_sentinel__', 'Chinese query must not degrade to sentinel');
});

test('ITEM-7-r2: sanitizeQuery still strips FTS5 syntax characters', () => {
  // Colons, dashes, quotes are FTS5 syntax — should become spaces
  const result = sanitizeQuery('memory:type "exact phrase" -excluded');
  assert.ok(!result.includes(':'), 'colon stripped');
  assert.ok(!result.includes('"'), 'quotes stripped');
  assert.ok(!result.includes('-'), 'dash stripped');
});

test('ITEM-7-r2: search returns Korean card by Korean query', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    const memoryId = 'mem_korean_001';
    upsertCard(idx, {
      payload: {
        memory_id: memoryId,
        memory_type: 'pattern',
        privacy_level: 'global',
        claim: '메모리 검색 회상 패턴',
        tags: ['메모리', 'Korean'],
        applicability: [],
        search_keywords: ['메모리', '회상', '검색'],
      },
    }, { projectId: '' });

    const rows = search(idx, '메모리 회상', { topN: 5 });
    const ids = rows.map((r) => r.memory_id);
    assert.ok(ids.includes(memoryId),
      `Korean query should find Korean card. Got ids: ${JSON.stringify(ids)}`);
  } finally {
    closeIndex(idx);
    cleanup();
  }
});

test('ITEM-7-r2: existing ASCII queries still work (\\p{L}\\p{N} is a superset of a-z0-9)', () => {
  const { dbPath, cleanup } = mkTmp();
  const idx = openIndex(dbPath);
  try {
    const memoryId = 'mem_ascii_001';
    upsertCard(idx, {
      payload: {
        memory_id: memoryId,
        memory_type: 'failure-case',
        privacy_level: 'global',
        claim: 'Codex skill discovery fails on YAML frontmatter',
        tags: ['codex', 'yaml'],
        applicability: [],
        search_keywords: ['codex', 'skill', 'yaml'],
      },
    }, { projectId: '' });

    const rows = search(idx, 'codex yaml skill', { topN: 5 });
    const ids = rows.map((r) => r.memory_id);
    assert.ok(ids.includes(memoryId), `ASCII query should still find ASCII card. Got: ${JSON.stringify(ids)}`);
  } finally {
    closeIndex(idx);
    cleanup();
  }
});
