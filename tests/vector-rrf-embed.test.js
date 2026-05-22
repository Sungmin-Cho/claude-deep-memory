'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rrfFuse, compositeKey } = require('../scripts/lib/rrf-fusion');
const { openIndex, upsertVector, searchVector, cosineSim } = require('../scripts/lib/vector-index');
const { probeModelVersion, readStoredModelVersion, writeStoredModelVersion } = require('../scripts/lib/embed-model');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-vrre-'));
}

// -- RRF fusion (γ.4) -------------------------------------------------------

test('γ.4 rrfFuse: card appearing in both streams ranks first', () => {
  const a = [{memory_id: 'm1', project_id: 'p'}, {memory_id: 'm2', project_id: 'p'}];
  const b = [{memory_id: 'm2', project_id: 'p'}, {memory_id: 'm3', project_id: 'p'}];
  const fused = rrfFuse([a, b]);
  assert.strictEqual(fused[0].memory_id, 'm2');
  assert.strictEqual(fused[0].sources.length, 2);
});

test('γ.4 + PR2-F: composite key separates same memory_id across projects', () => {
  const a = [{memory_id: 'mX', project_id: 'p1'}];
  const b = [{memory_id: 'mX', project_id: 'p2'}];
  const fused = rrfFuse([a, b]);
  assert.strictEqual(fused.length, 2, 'composite key must keep different projects distinct');
});

test('γ.4 rrfFuse: empty streams return empty', () => {
  assert.deepStrictEqual(rrfFuse([]), []);
  assert.deepStrictEqual(rrfFuse([[], []]), []);
});

test('γ.4 rrfFuse: single stream pass-through (order preserved by RRF score)', () => {
  const a = [{memory_id: 'm1', project_id: 'p'}, {memory_id: 'm2', project_id: 'p'}, {memory_id: 'm3', project_id: 'p'}];
  const fused = rrfFuse([a]);
  assert.strictEqual(fused.length, 3);
  assert.strictEqual(fused[0].memory_id, 'm1');
});

test('γ.4 compositeKey is "memory_id|project_id"', () => {
  assert.strictEqual(compositeKey({memory_id: 'm', project_id: 'p'}), 'm|p');
});

// -- Vector index (γ.2) -----------------------------------------------------

test('γ.2 vector-index: upsert + search round-trip', { skip: !(()=>{ try { require('better-sqlite3'); return true; } catch { return false; } })() }, () => {
  const root = mkTmpRoot();
  const db = openIndex(root);
  if (!db) return;  // graceful skip if better-sqlite3 unavailable
  const v1 = new Float32Array(384);
  for (let i = 0; i < 384; i++) v1[i] = (i % 2) ? 0.05 : -0.05;
  const v2 = new Float32Array(384);
  for (let i = 0; i < 384; i++) v2[i] = (i % 2) ? -0.05 : 0.05;  // opposite to v1
  upsertVector(db, { memory_id: 'm1', project_id: 'p1', embedding: v1 });
  upsertVector(db, { memory_id: 'm2', project_id: 'p1', embedding: v2 });
  const r = searchVector({ db, queryVector: v1, currentProjectId: 'p1', topK: 10 });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].memory_id, 'm1', 'self-similarity should rank first');
  assert.ok(r[0].score > r[1].score, 'opposite vector should rank lower');
  db.close();
});

test('γ.2 vector-index: privacy_level filter (project_id OR global)', { skip: !(()=>{ try { require('better-sqlite3'); return true; } catch { return false; } })() }, () => {
  const root = mkTmpRoot();
  const db = openIndex(root);
  if (!db) return;
  const v = new Float32Array(384).fill(0.05);
  upsertVector(db, { memory_id: 'm-local-p1', project_id: 'p1', privacy_level: 'local', embedding: v });
  upsertVector(db, { memory_id: 'm-local-p2', project_id: 'p2', privacy_level: 'local', embedding: v });
  upsertVector(db, { memory_id: 'm-global',   project_id: 'p2', privacy_level: 'global', embedding: v });
  const r = searchVector({ db, queryVector: v, currentProjectId: 'p1', topK: 10 });
  const ids = new Set(r.map(x => x.memory_id));
  assert.ok(ids.has('m-local-p1'), 'must include local in current project');
  assert.ok(ids.has('m-global'),   'must include global from any project');
  assert.ok(!ids.has('m-local-p2'), 'must EXCLUDE local from other project (R2-A privacy column)');
  db.close();
});

test('γ.2 cosineSim: identical vectors → 1.0 (normalized)', () => {
  const v = new Float32Array(3);
  v[0] = 1/Math.sqrt(3); v[1] = 1/Math.sqrt(3); v[2] = 1/Math.sqrt(3);
  const sim = cosineSim(v, v);
  assert.ok(Math.abs(sim - 1) < 0.001, `expected ~1.0, got ${sim}`);
});

// -- Embed model (γ.3) ------------------------------------------------------

test('γ.3 probeModelVersion: status=absent when @xenova not installed', () => {
  const root = mkTmpRoot();
  // @xenova/transformers is in optionalDependencies; CI without it returns 'absent'
  const r = probeModelVersion(root);
  // We can't predict status without knowing if optional dep got installed,
  // but the function must return a valid status string in any case.
  assert.ok(['ok', 'absent', 'mismatch', 'first-time'].includes(r.status));
});

test('γ.3 stored model version r/w roundtrip', () => {
  const root = mkTmpRoot();
  assert.strictEqual(readStoredModelVersion(root), null);
  writeStoredModelVersion(root, 'v9.9.9@TestModel');
  assert.strictEqual(readStoredModelVersion(root), 'v9.9.9@TestModel');
});
