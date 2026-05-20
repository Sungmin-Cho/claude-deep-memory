'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const {
  runRetrieve,
  tokenize,
  passesApplicabilityGuard,
  applyDiversity,
} = require('../scripts/retrieve');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-retrieve-'));
  for (const sub of ['cards', 'indexes', 'events', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

function plantCard(tmp, projectId, payload, envelopeExtra = {}) {
  const scope = payload.privacy_level === 'global' ? 'global' : projectId;
  const dir = path.join(tmp, 'cards', payload.memory_type, scope);
  fs.mkdirSync(dir, { recursive: true });
  const wrapped = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.1.0',
      artifact_kind: 'memory-card',
      run_id: 'run_test_' + payload.memory_id,
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ id: 'src_0' }], tool_versions: {} },
      ...envelopeExtra,
    },
    payload,
  };
  fs.writeFileSync(path.join(dir, payload.memory_id + '.json'), JSON.stringify(wrapped, null, 2));
  return wrapped;
}

function plantAndIndex(tmp, projectId, payload, envelopeExtra = {}) {
  const wrapped = plantCard(tmp, projectId, payload, envelopeExtra);
  const idx = openIndex(path.join(tmp, 'indexes', 'lexical.sqlite'));
  try {
    upsertCard(idx, wrapped, { projectId: payload.privacy_level === 'global' ? '' : projectId });
  } finally {
    closeIndex(idx);
  }
  return wrapped;
}

test('runRetrieve zero matches → empty memories + no error', async () => {
  const tmp = mkRoot();
  try {
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_x',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'totally unrelated subject matter',
      tags: [],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.5,
      status: 'candidate',
      dedupe_key: 'sha256:zerokey',
    });
    const result = await runRetrieve({
      task: 'codex',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
    });
    assert.deepStrictEqual(result.memories, []);
    assert.strictEqual(result.task, 'codex');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runRetrieve no index file → warning + empty memories', async () => {
  const tmp = mkRoot();
  try {
    const result = await runRetrieve({
      task: 'codex',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
    });
    assert.deepStrictEqual(result.memories, []);
    assert.ok(result.warnings.some((w) => w.includes('no lexical index')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 1: deprecated cards filtered out of result', async () => {
  const tmp = mkRoot();
  try {
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_active',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'codex skill discovery active card',
      tags: ['codex'],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.6,
      status: 'candidate',
      dedupe_key: 'sha256:active',
    });
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_deprecated',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'codex skill discovery deprecated card',
      tags: ['codex'],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.6,
      status: 'deprecated',
      dedupe_key: 'sha256:depr',
    });
    const result = await runRetrieve({
      task: 'codex skill discovery',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
    });
    const ids = result.memories.map((c) => c.payload.memory_id);
    assert.ok(ids.includes('mem_active'));
    assert.ok(!ids.includes('mem_deprecated'), 'deprecated card must be filtered');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 4: missing project_profile forces w_project_sim=0 (warning emitted)', async () => {
  const tmp = mkRoot();
  try {
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_x',
      memory_type: 'pattern',
      privacy_level: 'global',
      claim: 'codex skill discovery',
      tags: ['codex'],
      applicability: [{ value: 'language=typescript', source_id: 'src_0', confidence: 0.7 }],
      non_applicability: [],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.6,
      status: 'candidate',
      dedupe_key: 'sha256:nox',
    });
    const result = await runRetrieve({
      task: 'codex skill',
      memoryRoot: tmp,
      projectProfile: null,
    });
    assert.strictEqual(result.memories.length, 1);
    assert.ok(result.warnings.some((w) => w.includes('missing project-profile')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 6: applicability guard drops cards where task overlaps non_applicability', async () => {
  const tmp = mkRoot();
  try {
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_blocked',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'avoid claude code slash commands',
      tags: [],
      applicability: [],
      non_applicability: [
        { value: 'claude code slash command', source_id: 'src_0', confidence: 0.9 },
      ],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.7,
      status: 'candidate',
      dedupe_key: 'sha256:blocked',
    });
    plantAndIndex(tmp, 'proj_test', {
      memory_id: 'mem_ok',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'unrelated claude code slash command pattern',
      tags: [],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev'],
      search_keywords: [],
      confidence: 0.7,
      status: 'candidate',
      dedupe_key: 'sha256:ok',
    });
    const result = await runRetrieve({
      task: 'claude code slash command',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
    });
    const ids = result.memories.map((c) => c.payload.memory_id);
    assert.ok(!ids.includes('mem_blocked'), 'applicability guard drops blocked card');
    assert.ok(ids.includes('mem_ok'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 7: diversity collapses same dedupe_key clusters + caps per memory_type', async () => {
  const tmp = mkRoot();
  try {
    // 5 cards all same dedupe_key + same memory_type
    for (let i = 0; i < 5; i++) {
      plantAndIndex(tmp, 'proj_test', {
        memory_id: 'mem_' + i,
        memory_type: 'failure-case',
        privacy_level: 'local',
        claim: 'failing harvest test codex skill ' + i,
        tags: ['codex'],
        applicability: [],
        non_applicability: [],
        evidence_summary: ['ev' + i],
        search_keywords: [],
        confidence: 0.6,
        status: 'candidate',
        dedupe_key: 'sha256:duplicate_cluster', // same!
      });
    }
    const result = await runRetrieve({
      task: 'codex skill',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
      diversityPerType: 2,
    });
    assert.strictEqual(result.memories.length, 1, 'same dedupe_key collapses to 1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 7: diversity caps per memory_type at diversityPerType', async () => {
  const tmp = mkRoot();
  try {
    for (let i = 0; i < 5; i++) {
      plantAndIndex(tmp, 'proj_test', {
        memory_id: 'mem_' + i,
        memory_type: 'pattern',
        privacy_level: 'local',
        claim: 'codex skill pattern variant ' + i,
        tags: ['codex'],
        applicability: [],
        non_applicability: [],
        evidence_summary: ['ev' + i],
        search_keywords: [],
        confidence: 0.6,
        status: 'candidate',
        dedupe_key: 'sha256:dedup_' + i, // distinct!
      });
    }
    const result = await runRetrieve({
      task: 'codex skill',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test' },
      diversityPerType: 2,
    });
    assert.strictEqual(result.memories.length, 2, 'diversityPerType=2 caps pattern type to 2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tokenize splits on non-alphanumeric and lowercases', () => {
  assert.deepStrictEqual(tokenize('Codex / Skill-Discovery'), ['codex', 'skill', 'discovery']);
  assert.deepStrictEqual(tokenize(''), []);
});

test('passesApplicabilityGuard returns false at Jaccard ≥ 0.5 overlap', () => {
  const card = {
    payload: {
      non_applicability: [{ value: 'claude code slash command', confidence: 0.9 }],
    },
  };
  assert.strictEqual(passesApplicabilityGuard(card, tokenize('claude code slash command')), false);
  assert.strictEqual(passesApplicabilityGuard(card, tokenize('completely unrelated topic about ts')), true);
});

test('applyDiversity is a pure function with consistent ordering guarantees', () => {
  const cards = [
    { payload: { memory_type: 'a', dedupe_key: 'd1' } },
    { payload: { memory_type: 'a', dedupe_key: 'd1' } }, // duplicate dedupe — drop
    { payload: { memory_type: 'a', dedupe_key: 'd2' } },
    { payload: { memory_type: 'a', dedupe_key: 'd3' } }, // exceeds diversityPerType=2 — drop
    { payload: { memory_type: 'b', dedupe_key: 'd4' } },
  ];
  const out = applyDiversity(cards, 2);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((c) => c.payload.dedupe_key), ['d1', 'd2', 'd4']);
});
