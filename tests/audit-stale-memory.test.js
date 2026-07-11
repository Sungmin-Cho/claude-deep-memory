'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyAutoTransitions } = require('../scripts/audit');

function mkRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-stale-'));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(tmp, sub), { recursive: true });
  }
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
      provenance: { source_artifacts: [{ path: 'fixtures/x.json' }], tool_versions: {} },
    },
    payload,
  };
  const filepath = path.join(dir, payload.memory_id + '.json');
  fs.writeFileSync(filepath, JSON.stringify(wrapped, null, 2));
  return filepath;
}

test('Task 5.2: validated card with past review_after → deprecated + status_history grew by 1', () => {
  const tmp = mkRoot();
  try {
    const past = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    const cardPath = plant(tmp, {
      memory_id: 'mem_stale',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'old pattern',
      status: 'validated',
      status_history: [],
      review_after: past,
      evidence_summary: ['ev'],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: [],
      tags: [],
      confidence: 0.7,
      dedupe_key: 'sha256:stale',
    });
    const result = applyAutoTransitions(tmp, { projectId: PROJECT_ID });
    assert.strictEqual(result.transitioned, 1);
    assert.strictEqual(result.transitions[0].to, 'deprecated');
    assert.strictEqual(result.transitions[0].by, 'auto:review_after_past');
    const updated = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.strictEqual(updated.payload.status, 'deprecated');
    assert.strictEqual(updated.payload.status_history.length, 1);
    assert.strictEqual(updated.payload.status_history[0].from, 'validated');
    assert.strictEqual(updated.payload.status_history[0].to, 'deprecated');
    assert.strictEqual(updated.payload.status_history[0].by, 'auto:review_after_past');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.2: candidate with no triggers stays in candidate (no transition, no rewrite)', () => {
  const tmp = mkRoot();
  try {
    const future = new Date(Date.now() + 10 * 86400 * 1000).toISOString();
    const cardPath = plant(tmp, {
      memory_id: 'mem_stay',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'fresh pattern',
      status: 'candidate',
      status_history: [],
      review_after: future,
      evidence_summary: ['ev'],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: [],
      tags: [],
      confidence: 0.5,
      dedupe_key: 'sha256:stay',
    });
    const beforeMtime = fs.statSync(cardPath).mtimeMs;
    const result = applyAutoTransitions(tmp, { projectId: PROJECT_ID });
    assert.strictEqual(result.transitioned, 0);
    assert.deepStrictEqual(result.transitions, []);
    const afterMtime = fs.statSync(cardPath).mtimeMs;
    assert.strictEqual(beforeMtime, afterMtime, 'no transition → no rewrite');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.2: applyAutoTransitions with empty memory_root returns zero', () => {
  const tmp = mkRoot();
  try {
    const result = applyAutoTransitions(tmp);
    assert.deepStrictEqual(result, { total: 0, transitioned: 0, transitions: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task 5.2: status_history truncates at MAX_HISTORY (10) after transition push', () => {
  const tmp = mkRoot();
  try {
    const past = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    // Plant a card with 10 existing history entries — adding one more must
    // keep the array at 10 (oldest entry dropped via slice(-10)).
    const longHistory = Array.from({ length: 10 }, (_, i) => ({
      from: 'candidate',
      to: 'validated',
      at: new Date(Date.now() - (10 - i) * 1000).toISOString(),
      by: 'auto:test_' + i,
    }));
    const cardPath = plant(tmp, {
      memory_id: 'mem_full',
      memory_type: 'pattern',
      privacy_level: 'local',
      claim: 'fully historied',
      status: 'validated',
      status_history: longHistory,
      review_after: past,
      evidence_summary: ['ev'],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: [],
      tags: [],
      confidence: 0.7,
      dedupe_key: 'sha256:full',
    });
    applyAutoTransitions(tmp, { projectId: PROJECT_ID });
    const updated = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    assert.strictEqual(updated.payload.status_history.length, 10,
      'history capped at MAX_HISTORY=10 after the new transition is appended');
    assert.strictEqual(updated.payload.status_history[9].by, 'auto:review_after_past');
    assert.strictEqual(updated.payload.status_history[0].by, 'auto:test_1',
      'oldest entry (auto:test_0) was dropped to make room');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
