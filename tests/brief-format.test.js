'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  renderJson,
  renderMarkdown,
  renderMemory,
  defaultedAvoidWhen,
  defaultedRecommendedAction,
  DEFAULTS,
} = require('../scripts/lib/brief-format');

function cardWith(overrides = {}) {
  return {
    envelope: { provenance: { source_artifacts: [{ id: 'src_0', path: 'fixtures/sample.json' }] } },
    payload: {
      memory_id: 'mem_test',
      memory_type: 'failure-case',
      claim: 'Codex skill discovery fails',
      tags: ['codex', 'skill'],
      privacy_level: 'local',
      confidence: 0.7,
      non_applicability: [{ value: 'Claude-only', source_id: 'src_0', confidence: 0.8 }],
      recommended_action: ['Run manifest-drift CI test'],
      ...overrides,
    },
  };
}

test('renderJson: avoid_when maps from non_applicability[].value', () => {
  const out = renderJson('plugin migration', [cardWith()]);
  assert.strictEqual(out.payload.memories[0].avoid_when[0], 'Claude-only');
  assert.strictEqual(out.envelope.artifact_kind, 'memory-brief');
});

test('renderJson: per-card fallback when non_applicability is empty', () => {
  const out = renderJson('task', [cardWith({ non_applicability: [] })]);
  assert.deepStrictEqual(out.payload.memories[0].avoid_when, [DEFAULTS.avoid_when]);
});

test('renderJson: per-card fallback when recommended_action is empty', () => {
  const out = renderJson('task', [cardWith({ recommended_action: [] })]);
  assert.deepStrictEqual(out.payload.memories[0].recommended_action, [DEFAULTS.recommended_action]);
});

test('renderJson: count field reflects memories.length', () => {
  const out = renderJson('task', [cardWith(), cardWith({ memory_id: 'mem_b' })]);
  assert.strictEqual(out.payload.count, 2);
  assert.strictEqual(out.payload.memories.length, 2);
});

test('renderJson: single-card overload accepts a non-array argument', () => {
  const out = renderJson('task', cardWith(), { score: 0.7, why_relevant: 'tag match' });
  assert.strictEqual(out.payload.memories[0].why_relevant, 'tag match');
  assert.strictEqual(out.payload.memories[0].score, 0.7);
});

test('renderJson: task is echoed in payload', () => {
  const out = renderJson('migrate to typescript strict', [cardWith()]);
  assert.strictEqual(out.payload.task, 'migrate to typescript strict');
});

test('renderJson: envelope is wrapped (producer/schema/artifact_kind)', () => {
  const out = renderJson('task', [cardWith()]);
  assert.strictEqual(out.envelope.producer, 'deep-memory');
  assert.strictEqual(out.envelope.schema.name, 'memory-brief');
});

test('renderMemory: falls back to extra.score when card lacks score', () => {
  const m = renderMemory(cardWith(), { score: 0.42 });
  assert.strictEqual(m.score, 0.42);
});

test('renderMemory: card.score wins over extra.score', () => {
  const m = renderMemory({ ...cardWith(), score: 0.9 }, { score: 0.1 });
  assert.strictEqual(m.score, 0.9);
});

test('renderMarkdown: empty memories list produces "no memories yet" guidance', () => {
  const md = renderMarkdown('codex migration', []);
  assert.match(md, /No memories yet/);
  assert.match(md, /\/deep-memory-harvest/);
});

test('renderMarkdown: includes fallback "(none specified)" when applicable', () => {
  const md = renderMarkdown('task', [cardWith({ non_applicability: [] })]);
  assert.match(md, /\(none specified\)/);
});

test('renderMarkdown: includes claim, evidence, tags rendered as code spans', () => {
  const md = renderMarkdown('task', [cardWith()]);
  assert.match(md, /\*\*Claim:\*\* Codex skill discovery fails/);
  assert.match(md, /fixtures\/sample\.json/);
  assert.match(md, /`codex`/);
  assert.match(md, /`skill`/);
});

test('renderMarkdown: title shows correct singular/plural', () => {
  assert.match(renderMarkdown('t', [cardWith()]), /1 memory retrieved/);
  assert.match(renderMarkdown('t', [cardWith(), cardWith({ memory_id: 'b' })]), /2 memories retrieved/);
});

test('defaultedAvoidWhen unit: empty list → [DEFAULTS.avoid_when]', () => {
  assert.deepStrictEqual(
    defaultedAvoidWhen({ payload: { non_applicability: [] } }),
    [DEFAULTS.avoid_when]
  );
  assert.deepStrictEqual(
    defaultedAvoidWhen({ payload: { non_applicability: [{ value: 'X' }, { value: 'Y' }] } }),
    ['X', 'Y']
  );
});

test('defaultedRecommendedAction unit: empty list → [DEFAULTS.recommended_action]', () => {
  assert.deepStrictEqual(
    defaultedRecommendedAction({ payload: { recommended_action: [] } }),
    [DEFAULTS.recommended_action]
  );
});
