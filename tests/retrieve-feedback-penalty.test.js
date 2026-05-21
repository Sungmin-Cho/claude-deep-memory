'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { runRetrieve } = require('../scripts/retrieve');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-feedback-'));
  for (const sub of ['cards', 'indexes', 'events', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
  return tmp;
}

function plantCard(tmp, projectId, payload) {
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
    },
    payload,
  };
  fs.writeFileSync(path.join(dir, payload.memory_id + '.json'), JSON.stringify(wrapped, null, 2));
  const idx = openIndex(path.join(tmp, 'indexes', 'lexical.sqlite'));
  try {
    upsertCard(idx, wrapped, { projectId: payload.privacy_level === 'global' ? '' : projectId });
  } finally {
    closeIndex(idx);
  }
  return wrapped;
}

test('ITEM-8-r2: card with rejected_count=10 ranks lower than fresh card with identical claim/confidence', async () => {
  const tmp = mkRoot();
  try {
    const sharedClaim = 'memory retrieval pattern for codex skill';

    // cardA: high rejected_count (should rank lower)
    plantCard(tmp, 'proj_test', {
      memory_id: 'mem_rejected',
      memory_type: 'pattern',
      privacy_level: 'global',
      claim: sharedClaim,
      tags: ['codex', 'memory', 'retrieval'],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev1', 'ev2'],
      search_keywords: ['codex', 'memory', 'retrieval'],
      confidence: 0.8,
      status: 'candidate',
      dedupe_key: 'sha256:mem_rejected',
      feedback: {
        accepted_count: 0,
        rejected_count: 10,
        inaccurate_count: 0,
      },
    });

    // cardB: zero feedback (should rank higher)
    plantCard(tmp, 'proj_test', {
      memory_id: 'mem_fresh',
      memory_type: 'pattern',
      privacy_level: 'global',
      claim: sharedClaim,
      tags: ['codex', 'memory', 'retrieval'],
      applicability: [],
      non_applicability: [],
      evidence_summary: ['ev1', 'ev2'],
      search_keywords: ['codex', 'memory', 'retrieval'],
      confidence: 0.8,
      status: 'candidate',
      dedupe_key: 'sha256:mem_fresh',
      feedback: {
        accepted_count: 0,
        rejected_count: 0,
        inaccurate_count: 0,
      },
    });

    const result = await runRetrieve({
      task: 'codex memory retrieval pattern',
      memoryRoot: tmp,
      projectProfile: { project_id: 'proj_test', signature: { languages: [] } },
      topN: 10,
    });

    const memories = result.memories;
    assert.ok(memories.length >= 2, `Expected at least 2 results, got ${memories.length}`);

    const rejIdx = memories.findIndex((m) => m.payload.memory_id === 'mem_rejected');
    const freshIdx = memories.findIndex((m) => m.payload.memory_id === 'mem_fresh');

    assert.ok(rejIdx >= 0, 'mem_rejected should appear in results');
    assert.ok(freshIdx >= 0, 'mem_fresh should appear in results');

    assert.ok(
      freshIdx < rejIdx,
      `mem_fresh (idx ${freshIdx}) should rank higher (lower index) than mem_rejected (idx ${rejIdx}). rejected_count=10 must penalize ranking.`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
