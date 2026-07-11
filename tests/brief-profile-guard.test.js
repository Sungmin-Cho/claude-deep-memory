'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { run } = require('../scripts/brief');
const { deriveProjectId } = require('../scripts/lib/project-resolver');
const {
  makeValidProjectProfile,
  makeSameIdInvalidProfiles,
} = require('./helpers/project-profile-fixtures');

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

function card(memoryId, scope) {
  const payload = {
    memory_id: memoryId,
    memory_type: 'failure-case',
    privacy_level: scope === 'global' ? 'global' : 'local',
    claim: `project guard claim ${memoryId}`,
    tags: ['guard'],
    applicability: [],
    non_applicability: [],
    recommended_action: ['retain privacy boundary'],
    search_keywords: ['project', 'guard', 'claim'],
    evidence_summary: ['fixture'],
    confidence: 0.9,
    status: 'candidate',
    dedupe_key: `sha256:${Buffer.from(memoryId).toString('hex').padEnd(64, '0').slice(0, 64)}`,
  };
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '1.0.2',
      artifact_kind: 'memory-card',
      run_id: `run-${memoryId}`,
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: `fixture/${memoryId}.json` }], tool_versions: {} },
    },
    payload,
  };
}

function plant(memoryRoot, wrapped, scope) {
  const dir = path.join(memoryRoot, 'cards', wrapped.payload.memory_type, scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${wrapped.payload.memory_id}.json`), JSON.stringify(wrapped));
  const index = openIndex(path.join(memoryRoot, 'indexes/v2/lexical.sqlite'));
  try { upsertCard(index, wrapped, { projectId: scope === 'global' ? '' : scope }); }
  finally { closeIndex(index); }
}

function writeProfile(projectRoot, profile) {
  const dir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile));
}

function returnedIds(projectRoot) {
  const brief = JSON.parse(fs.readFileSync(path.join(projectRoot, '.deep-memory/latest-brief.json'), 'utf8'));
  return brief.payload.memories.map((memory) => memory.memory_id);
}

test('brief reads global-only for every untrusted profile state', async (t) => {
  const memoryRoot = fixture(t, 'dm-brief-memory-');
  const projectRoot = fixture(t, 'dm-brief-project-');
  const foreignRoot = fixture(t, 'dm-brief-foreign-');
  const projectId = deriveProjectId(projectRoot);
  plant(memoryRoot, card('mem_global_guard', 'global'), 'global');
  plant(memoryRoot, card('mem_local_forbidden', projectId), projectId);
  const valid = makeValidProjectProfile(projectRoot);
  const states = [
    ['missing', null],
    ['invalid-json', '{'],
    ...Object.entries(makeSameIdInvalidProfiles(valid)),
    ['foreign-id', { ...valid, project_id: deriveProjectId(foreignRoot) }],
    ['copied-a-to-b', makeValidProjectProfile(foreignRoot)],
  ];

  for (const [name, profile] of states) {
    fs.rmSync(path.join(projectRoot, '.deep-memory'), { recursive: true, force: true });
    if (profile !== null) writeProfile(projectRoot, profile);
    const result = await run({ task: 'project guard claim', projectDir: projectRoot, memoryRoot, topN: 10 });
    assert.ok(Array.isArray(result.warnings), name);
    const ids = returnedIds(projectRoot);
    assert.ok(ids.includes('mem_global_guard'), name);
    assert.ok(!ids.includes('mem_local_forbidden'), name);
  }
});

test('brief reads exactly global plus matching local scope for a trusted profile', async (t) => {
  const memoryRoot = fixture(t, 'dm-brief-happy-memory-');
  const projectRoot = fixture(t, 'dm-brief-happy-project-');
  const projectId = deriveProjectId(projectRoot);
  plant(memoryRoot, card('mem_global_happy', 'global'), 'global');
  plant(memoryRoot, card('mem_local_happy', projectId), projectId);
  writeProfile(projectRoot, makeValidProjectProfile(projectRoot));
  await run({ task: 'project guard claim', projectDir: projectRoot, memoryRoot, topN: 10 });
  assert.deepEqual(new Set(returnedIds(projectRoot)), new Set(['mem_global_happy', 'mem_local_happy']));
});
