'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { detectDedupeCollisions } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-dedupe-'));
  fs.mkdirSync(path.join(tmp, 'cards'), { recursive: true });
  return tmp;
}

const PROJECT_ID = 'proj_aaaaaaaaaaaa';

function plant(tmp, payload) {
  const scope = payload.privacy_level === 'global' ? 'global' : PROJECT_ID;
  const dir = path.join(tmp, 'cards', payload.memory_type, scope);
  fs.mkdirSync(dir, { recursive: true });
  const wrapped = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.1.0',
      artifact_kind: 'memory-card',
      run_id: 'run_' + payload.memory_id,
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: 'x.json' }], tool_versions: {} },
    },
    payload,
  };
  const fp = path.join(dir, payload.memory_id + '.json');
  fs.writeFileSync(fp, JSON.stringify(wrapped, null, 2));
  return fp;
}

test('Task 5.4: same dedupe_key + contradicting applicability → applicability_contradiction', () => {
  const tmp = mkRoot();
  try {
    plant(tmp, {
      memory_id: 'mem_a',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'shared claim',
      dedupe_key: 'sha256:shared',
      applicability: [
        { value: 'language=ts', source_id: 'src_0', confidence: 0.7 },
      ],
      non_applicability: [], evidence_summary: ['ev'], recommended_action: [],
      search_keywords: [], tags: [], status: 'candidate', status_history: [],
      confidence: 0.6,
    });
    plant(tmp, {
      memory_id: 'mem_b',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'shared claim',
      dedupe_key: 'sha256:shared',
      applicability: [
        { value: 'language=go', source_id: 'src_0', confidence: 0.7 },
      ],
      non_applicability: [], evidence_summary: ['ev'], recommended_action: [],
      search_keywords: [], tags: [], status: 'candidate', status_history: [],
      confidence: 0.6,
    });
    const result = detectDedupeCollisions(tmp, { projectId: PROJECT_ID });
    assert.strictEqual(result.scanned, 2);
    assert.strictEqual(result.collisions.length, 1);
    assert.strictEqual(result.collisions[0].dedupe_key, 'sha256:shared');
    assert.strictEqual(result.collisions[0].contradiction_kind, 'applicability_contradiction');
    assert.deepStrictEqual(result.collisions[0].memory_ids.sort(), ['mem_a', 'mem_b']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.4: same dedupe_key + identical applicability → duplicate', () => {
  const tmp = mkRoot();
  try {
    for (const id of ['mem_a', 'mem_b']) {
      plant(tmp, {
        memory_id: id,
        memory_type: 'pattern',
        privacy_level: 'local',
        claim: 'shared',
        dedupe_key: 'sha256:dup',
        applicability: [{ value: 'lang=ts', source_id: 'src_0', confidence: 0.7 }],
        non_applicability: [], evidence_summary: ['ev'], recommended_action: [],
        search_keywords: [], tags: [], status: 'candidate', status_history: [],
        confidence: 0.6,
      });
    }
    const result = detectDedupeCollisions(tmp, { projectId: PROJECT_ID });
    assert.strictEqual(result.collisions[0].contradiction_kind, 'duplicate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.4: distinct dedupe_key → no collision', () => {
  const tmp = mkRoot();
  try {
    plant(tmp, {
      memory_id: 'mem_a', memory_type: 'pattern', privacy_level: 'local',
      claim: 'A', dedupe_key: 'sha256:aa', applicability: [],
      non_applicability: [], evidence_summary: ['ev'], recommended_action: [],
      search_keywords: [], tags: [], status: 'candidate', status_history: [],
      confidence: 0.5,
    });
    plant(tmp, {
      memory_id: 'mem_b', memory_type: 'pattern', privacy_level: 'local',
      claim: 'B', dedupe_key: 'sha256:bb', applicability: [],
      non_applicability: [], evidence_summary: ['ev'], recommended_action: [],
      search_keywords: [], tags: [], status: 'candidate', status_history: [],
      confidence: 0.5,
    });
    const result = detectDedupeCollisions(tmp, { projectId: PROJECT_ID });
    assert.strictEqual(result.collisions.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.4: empty memory_root returns zeros', () => {
  const tmp = mkRoot();
  try {
    const result = detectDedupeCollisions(tmp);
    assert.deepStrictEqual(result, { scanned: 0, collisions: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
