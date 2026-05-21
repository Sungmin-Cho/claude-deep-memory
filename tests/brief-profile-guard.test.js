'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { run } = require('../scripts/brief');
const { projectId: deriveProjectId } = require('../scripts/init');
const { writeJsonAtomic } = require('../scripts/lib/atomic-write');

function setup() {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-guard-mem-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-guard-proj-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(memoryRoot, sub), { recursive: true });
  }
  return {
    memoryRoot,
    projectDir,
    cleanup: () => {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function makePayload(memoryId, projectScope) {
  return {
    memory_id: memoryId,
    memory_type: 'failure-case',
    privacy_level: projectScope === 'global' ? 'global' : 'local',
    claim: 'test claim ' + memoryId,
    tags: ['test'],
    applicability: [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: ['test'],
    evidence_summary: ['ev1'],
    confidence: 0.7,
    status: 'candidate',
    dedupe_key: 'sha256:' + Buffer.from(memoryId).toString('hex').padEnd(64, '0'),
  };
}

function plantCard(memoryRoot, payload, scopeDir) {
  const dir = path.join(memoryRoot, 'cards', payload.memory_type, scopeDir);
  fs.mkdirSync(dir, { recursive: true });
  const wrapped = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.1.0',
      artifact_kind: 'memory-card',
      run_id: 'run_guard',
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: {
        source_artifacts: [{ path: '~/fixtures/' + payload.memory_id + '.json' }],
        tool_versions: {},
      },
    },
    payload,
  };
  fs.writeFileSync(
    path.join(dir, payload.memory_id + '.json'),
    JSON.stringify(wrapped, null, 2)
  );
  const projectId = scopeDir === 'global' ? '' : scopeDir;
  const idx = openIndex(path.join(memoryRoot, 'indexes', 'lexical.sqlite'));
  try {
    upsertCard(idx, wrapped, { projectId });
  } finally {
    closeIndex(idx);
  }
  return wrapped;
}

test('ITEM-3: brief.run rejects spoofed project-profile and returns only global cards with mismatch warning', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    // Compute what project_id the real cwd would produce
    const realId = deriveProjectId(projectDir);

    // Plant a local card scoped to realId (the "real" project's local card)
    const localPayload = makePayload('mem_local_real', realId);
    plantCard(memoryRoot, localPayload, realId);

    // Plant a global card (visible to all)
    const globalPayload = makePayload('mem_global_one', 'global');
    plantCard(memoryRoot, globalPayload, 'global');

    // Write a spoofed project-profile with a DIFFERENT project_id (valid format, but wrong)
    const spoofedId = 'proj_000000000000';
    const profileDir = path.join(projectDir, '.deep-memory');
    fs.mkdirSync(profileDir, { recursive: true });
    writeJsonAtomic(path.join(profileDir, 'project-profile.json'), {
      project_id: spoofedId,
      generated_at: new Date().toISOString(),
    });

    const r = await run({ task: 'test claim', projectDir, memoryRoot });

    // Must have the mismatch warning
    assert.ok(
      r.warnings && r.warnings.some((w) => /project-profile mismatch/.test(w)),
      `Expected mismatch warning in: ${JSON.stringify(r.warnings)}`
    );

    // The local card for realId must NOT appear (spoofed profile was rejected,
    // so the realId scope was never passed to search)
    const memoryIds = r.warnings; // just ensure no local card IDs leak
    // More directly: count should come from global-only search
    // The global card should be retrievable
    const brief = JSON.parse(fs.readFileSync(
      path.join(projectDir, '.deep-memory', 'latest-brief.json'), 'utf8'
    ));
    const returnedIds = brief.payload.memories.map((m) => m.memory_id);
    assert.ok(
      !returnedIds.includes('mem_local_real'),
      `Local card for realId must not appear in spoofed-profile result. Got: ${JSON.stringify(returnedIds)}`
    );
    // Global card should be present (global cards are always visible)
    assert.ok(
      returnedIds.includes('mem_global_one'),
      `Global card should appear in result. Got: ${JSON.stringify(returnedIds)}`
    );
  } finally {
    cleanup();
  }
});

test('ITEM-3: brief.run happy path with matching profile is unaffected (no regression)', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    // Plant a global card and verify no spurious mismatch warning
    const globalPayload = makePayload('mem_global_happy', 'global');
    plantCard(memoryRoot, globalPayload, 'global');

    // No project-profile.json at all → existing missing-profile path (regression test)
    const r = await run({ task: 'test claim', projectDir, memoryRoot });
    assert.ok(
      !r.warnings.some((w) => /project-profile mismatch/.test(w)),
      'No mismatch warning when profile is absent'
    );
    assert.ok(
      r.warnings.some((w) => /missing project-profile/.test(w)),
      'Should still get the normal missing-profile warning'
    );
  } finally {
    cleanup();
  }
});
