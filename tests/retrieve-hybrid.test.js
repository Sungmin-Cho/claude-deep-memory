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
  // Stub FTS5 search returning 3 cards from current project (card files on
  // disk — R3 #1 fail-closed drops rows whose card cannot be located)
  const ftsCards = [
    { memory_id: 'm1', project_id: 'p1', session_id: 'sA' },
    { memory_id: 'm2', project_id: 'p1', session_id: 'sA' },
    { memory_id: 'm3', project_id: 'p1', session_id: 'sB' }
  ];
  for (const c of ftsCards) writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: c.memory_id });
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
  // Stub FTS5: 5 cards, all session sA (card files on disk per R3 #1)
  const ftsCards = Array.from({length: 5}, (_, i) => ({
    memory_id: `m${i}`, project_id: 'p1', session_id: 'sA'
  }));
  for (const c of ftsCards) writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: c.memory_id });
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

test('R3 #1: rows whose card file is missing are DROPPED with one bounded skew warning (fail-closed)', async () => {
  // A stale FTS/vector row whose card was deleted (forget/audit) must not
  // surface its claim text through MCP — card state is unverifiable, so the
  // row is dropped and the index/card skew is surfaced once, boundedly.
  const root = mkTmpRoot();
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [
      { memory_id: 'm_ghost1', project_id: 'p1', memory_type: 'pattern', claim: 'forgotten secret claim' },
      { memory_id: 'm_ghost2', project_id: 'p1', memory_type: 'pattern' },
    ],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 0, 'unverifiable rows must be dropped (fail-closed)');
  const skew = result.warnings.filter(w => w.startsWith('card_filter_dropped:'));
  assert.strictEqual(skew.length, 1, `expected ONE aggregate skew warning, got: ${JSON.stringify(result.warnings)}`);
  assert.match(skew[0], /\b2\b/, 'warning should carry the dropped-row count');
  assert.ok(!skew[0].includes('forgotten secret claim'), 'warning must not echo card content');
});

// R4 #2/#3/#4 — scope-strict locate / payload enrichment / lexical-only option

test('R4 #2: a local row is NOT validated by a same-id global card (scope-strict fail-closed)', async () => {
  const root = mkTmpRoot();
  // The local scoped card was deleted; a global card with the same memory_id
  // remains (memory_id is deterministic from type/claim, not scope).
  writeCard(root, { memory_type: 'pattern', project_id: 'global', memory_id: 'm_dup' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [
      { memory_id: 'm_dup', project_id: 'p1', privacy_level: 'local', memory_type: 'pattern', claim: 'stale local claim' },
    ],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 0, 'stale local row must not be validated by a global card');
  assert.ok(result.warnings.some(w => w.startsWith('card_filter_dropped:')));
});

test('R4 #2: a global-privacy row still resolves via the global directory', async () => {
  const root = mkTmpRoot();
  writeCard(root, { memory_type: 'pattern', project_id: 'global', memory_id: 'm_glob' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p2', root,
    ftsSearch: async () => [
      { memory_id: 'm_glob', project_id: 'p9', privacy_level: 'global', memory_type: 'pattern' },
    ],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 1, 'global-privacy row must resolve from the global dir');
});

test('R4 #3: fields missing on the fused row are filled from the validated card payload', async () => {
  const root = mkTmpRoot();
  writeCardWithClaim(root, { memory_type: 'pattern', project_id: 'p1', memory_id: 'm_enrich', claim: 'card claim text' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [{ memory_id: 'm_enrich', project_id: 'p1' }],  // vector-shape: no claim/memory_type
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 1);
  assert.strictEqual(result.memories[0].claim, 'card claim text', 'claim must be filled from the card payload');
  assert.strictEqual(result.memories[0].memory_type, 'pattern', 'memory_type must be filled from the card payload');
});

function writeCardWithClaim(root, { memory_type, project_id, memory_id, claim }) {
  const dir = path.join(root, 'cards', memory_type, project_id || 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, memory_id + '.json'), JSON.stringify({
    payload: { memory_id, memory_type, status: 'active', non_applicability: [], claim },
  }));
}

test('R4 #4: useVector:false keeps retrieval lexical-only (no vector probe, no vector warnings)', async () => {
  const root = mkTmpRoot();
  writeCard(root, { memory_type: 'pattern', project_id: 'p1', memory_id: 'm_lex' });
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p1', root,
    ftsSearch: async () => [{ memory_id: 'm_lex', project_id: 'p1', memory_type: 'pattern' }],
    topN: 5,
    useVector: false,
  });
  assert.deepStrictEqual(result.streams_used, ['fts5']);
  assert.ok(!result.warnings.some(w => w.includes('vector_stream')),
    `lexical-only mode must not emit vector-stream warnings, got: ${JSON.stringify(result.warnings)}`);
});

test('R5 P1: a global-privacy row is NOT validated by a same-id LOCAL card (global scope only)', async () => {
  // Vector rows keep their origin project_id even when privacy_level is
  // 'global'. If the global card is gone but a same-id LOCAL card exists in
  // the origin project, the row must still fail closed — otherwise another
  // project's retrieval validates a global row with local-only payload.
  const root = mkTmpRoot();
  writeCard(root, { memory_type: 'pattern', project_id: 'pX', memory_id: 'm_shadow' });  // local shadow only
  const result = await runHybridRetrieve({
    query: 'anything', currentProjectId: 'p2', root,
    ftsSearch: async () => [
      { memory_id: 'm_shadow', project_id: 'pX', privacy_level: 'global', memory_type: 'pattern' },
    ],
    topN: 5,
  });
  assert.strictEqual(result.memories.length, 0, 'global row must resolve from global/ only');
  assert.ok(result.warnings.some(w => w.startsWith('card_filter_dropped:')));
});
