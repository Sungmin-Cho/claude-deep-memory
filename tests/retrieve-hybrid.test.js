'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHybridRetrieve, sessionDiversify, probeStreams } = require('../scripts/lib/retrieve-hybrid');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-retrieve-hybrid-'));
}

// γ.6 sessionDiversify ------------------------------------------------------

test('γ.6 sessionDiversify: caps at maxPerSession (default 3)', () => {
  const cards = [
    { memory_id: 'm1', session_id: 'sA' },
    { memory_id: 'm2', session_id: 'sA' },
    { memory_id: 'm3', session_id: 'sA' },
    { memory_id: 'm4', session_id: 'sA' },  // 4th — should be dropped
    { memory_id: 'm5', session_id: 'sB' }
  ];
  const out = sessionDiversify(cards, 3);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out.find(c => c.memory_id === 'm4'), undefined);
});

test('γ.6 sessionDiversify: cards without session_id bypass cap (v0.1.x sibling-origin)', () => {
  const cards = [
    { memory_id: 'm1', session_id: null },
    { memory_id: 'm2', session_id: null },
    { memory_id: 'm3', session_id: null },
    { memory_id: 'm4', session_id: null }
  ];
  const out = sessionDiversify(cards, 1);
  assert.strictEqual(out.length, 4, 'null session_id should all pass');
});

// γ.7 probeStreams ----------------------------------------------------------

test('γ.7 probeStreams: returns valid status + warnings array', () => {
  const root = mkTmpRoot();
  const r = probeStreams(root);
  assert.strictEqual(typeof r.vector_available, 'boolean');
  assert.ok(Array.isArray(r.warnings));
});

// γ.5 runHybridRetrieve -----------------------------------------------------

test('γ.5 runHybridRetrieve: FTS5-only path (no vector) returns FTS5 stream', async () => {
  const root = mkTmpRoot();
  // Stub FTS5 search returning 3 cards from current project
  const ftsCards = [
    { memory_id: 'm1', project_id: 'p1', session_id: 'sA' },
    { memory_id: 'm2', project_id: 'p1', session_id: 'sA' },
    { memory_id: 'm3', project_id: 'p1', session_id: 'sB' }
  ];
  const result = await runHybridRetrieve({
    query: 'test query',
    currentProjectId: 'p1',
    root,
    ftsSearch: async () => ftsCards,
    topN: 5
  });
  assert.strictEqual(result.memories.length, 3);
  assert.ok(result.streams_used.includes('fts5'));
});

test('γ.5 + γ.7: empty FTS5 + vector unavailable → empty memories with warnings', async () => {
  const root = mkTmpRoot();
  const result = await runHybridRetrieve({
    query: 'test',
    currentProjectId: 'p1',
    root,
    ftsSearch: null  // no FTS callback
  });
  assert.strictEqual(result.memories.length, 0);
  assert.ok(result.warnings.length >= 1);
  assert.ok(result.warnings.some(w => w.includes('fts_stream_skipped') || w.includes('vector_stream_skipped')),
    `expected stream-skipped warnings, got: ${result.warnings.join('; ')}`);
});

test('γ.5 + γ.6: hybrid fuse + session diversification combined', async () => {
  const root = mkTmpRoot();
  // Stub FTS5: 5 cards, all session sA
  const ftsCards = Array.from({length: 5}, (_, i) => ({
    memory_id: `m${i}`, project_id: 'p1', session_id: 'sA'
  }));
  const result = await runHybridRetrieve({
    query: 'test',
    currentProjectId: 'p1',
    root,
    ftsSearch: async () => ftsCards,
    topN: 10,
    config: { brief: { max_per_session: 2 } }
  });
  // 5 cards in same session capped to 2 per max_per_session
  assert.strictEqual(result.memories.length, 2);
});

// R2 #3 — card-state filter parity with scripts/retrieve.js (Stage 1 + Stage 6)

function writeCard(root, { memory_type, project_id, memory_id, status, non_applicability }) {
  const dir = path.join(root, 'cards', memory_type, project_id || 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, memory_id + '.json'), JSON.stringify({
    payload: { memory_id, memory_type, status: status || 'active', non_applicability: non_applicability || [] },
  }));
}

test('R2 #3: deprecated cards are dropped from hybrid results (Stage 1 parity)', async () => {
  const root = mkTmpRoot();
  writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: 'm_live' });
  writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: 'm_dead', status: 'deprecated' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [
      { memory_id: 'm_live', project_id: 'p1', memory_type: 'pattern' },
      { memory_id: 'm_dead', project_id: 'p1', memory_type: 'pattern' },
    ],
    topN: 5,
  });
  const ids = result.memories.map(m => m.memory_id);
  assert.ok(ids.includes('m_live'), `live card must survive, got ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('m_dead'), 'deprecated card must not surface via the MCP hybrid path');
});

test('R2 #3: non-applicability guard drops cards matching the query (Stage 6 parity)', async () => {
  const root = mkTmpRoot();
  writeCard(root, {
    memory_type: 'pattern', project_id: 'p1', memory_id: 'm_na',
    non_applicability: [{ value: 'flaky network retry' }],
  });
  const result = await runHybridRetrieve({
    query: 'flaky network retry', currentProjectId: 'p1', root,
    ftsSearch: async () => [{ memory_id: 'm_na', project_id: 'p1', memory_type: 'pattern' }],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 0, 'non-applicable card must be dropped');
});

test('R2 #3: deprecated filter also applies to rows lacking memory_type (vector stream shape)', async () => {
  const root = mkTmpRoot();
  writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: 'm_vdead', status: 'deprecated' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [{ memory_id: 'm_vdead', project_id: 'p1' }],  // no memory_type, like searchVector rows
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 0, 'deprecated card must be dropped even without memory_type on the row');
});

test('R2 #3: rows whose card file is missing pass through unchanged (graceful degradation preserved)', async () => {
  const root = mkTmpRoot();
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [{ memory_id: 'm_ghost', project_id: 'p1', memory_type: 'pattern' }],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 1, 'missing card payload must not drop the row (fail-open)');
});
