'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeStepB } = require('../scripts/harvest');

/**
 * ITEM-6-r2: Step B claim_refined is applied for ALL mapper source kinds,
 * including those where the composite claim differs from title.
 *
 * Pre-ITEM-6: the guard `draft.claim === draft.title` silently dropped
 * claim_refined for mapWorkReceipt / mapDocsScan / mapWikiIndex because
 * those mappers compose claims ("Failure: <title> — <reason>", etc.).
 *
 * Post-ITEM-6: `claim_refined.length > 0` → claim always replaced.
 */

test('ITEM-6-r2: mergeStepB refines claim for work-receipt composite claim (outcome=success)', () => {
  // mapWorkReceipt produces: claim = "<title> — succeeded in <duration>s"
  // which is never === title
  const draft = {
    memory_type: 'pattern',
    title: 'Use build cache across CI runs',
    claim: 'Use build cache across CI runs — succeeded in 4.2s',
    evidence_summary: ['session_001'],
    applicability: [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: ['deep-work', 'pattern'],
    confidence: 0.5,
  };
  const stepB = {
    claim_refined: 'Build cache sharing reduces CI time by 60% — always warm npm cache between jobs',
    non_applicability: [],
    recommended_action: ['Configure --cache-dir in .npmrc for CI runners'],
    search_keywords: ['build', 'cache', 'CI', 'npm', 'performance'],
  };
  const sourceMeta = { id: 'src_0' };

  mergeStepB(draft, stepB, sourceMeta);

  assert.strictEqual(
    draft.claim,
    'Build cache sharing reduces CI time by 60% — always warm npm cache between jobs',
    'claim_refined must replace composite work-receipt claim'
  );
  assert.deepStrictEqual(draft.recommended_action, ['Configure --cache-dir in .npmrc for CI runners']);
  assert.deepStrictEqual(draft.search_keywords, ['build', 'cache', 'CI', 'npm', 'performance']);
});

test('ITEM-6-r2: mergeStepB refines claim for work-receipt composite claim (outcome=failure)', () => {
  // mapWorkReceipt failure: claim = "Failure: <title> — <failure_reason>"
  const draft = {
    memory_type: 'failure-case',
    title: 'Run integration tests against staging DB',
    claim: 'Failure: Run integration tests against staging DB — DB connection timeout',
    evidence_summary: ['session_002'],
    applicability: [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: ['deep-work', 'failure-case'],
    confidence: 0.5,
  };
  const stepB = {
    claim_refined: 'Integration tests fail when staging DB has connection pool exhaustion under load',
    non_applicability: [{ value: 'projects without staging DB', confidence: 0.7 }],
    recommended_action: ['Set max_connections=20 in staging DB config', 'Add retry with exponential backoff'],
    search_keywords: ['integration', 'test', 'DB', 'timeout', 'staging', 'connection'],
  };
  const sourceMeta = { id: 'src_0' };

  mergeStepB(draft, stepB, sourceMeta);

  assert.strictEqual(
    draft.claim,
    'Integration tests fail when staging DB has connection pool exhaustion under load',
    'claim_refined must replace composite failure-case claim'
  );
  assert.strictEqual(draft.non_applicability[0].value, 'projects without staging DB');
  assert.strictEqual(draft.non_applicability[0].source_id, 'src_0');
});

test('ITEM-6-r2: mergeStepB refines claim for docs-scan composite claim', () => {
  // mapDocsScan: claim = "<title> — <recommended_fix>"
  const draft = {
    memory_type: 'coding-style',
    title: 'CLAUDE.md references removed file scripts/legacy-init.js',
    claim: 'CLAUDE.md references removed file scripts/legacy-init.js — remove reference or restore file',
    evidence_summary: ['CLAUDE.md'],
    applicability: [{ value: 'language=markdown', source_id: 'src_0', confidence: 0.6 }],
    non_applicability: [],
    recommended_action: ['remove reference or restore file'],
    search_keywords: [],
    tags: ['deep-docs', 'style'],
    confidence: 0.5,
  };
  const stepB = {
    claim_refined: 'Documentation files referencing deleted source files cause confusion — prune stale references in CI',
    non_applicability: [],
    recommended_action: ['Add a CI check that validates all file references in CLAUDE.md exist on disk'],
    search_keywords: ['CLAUDE.md', 'stale', 'reference', 'docs', 'documentation'],
  };
  const sourceMeta = { id: 'src_0' };

  mergeStepB(draft, stepB, sourceMeta);

  assert.strictEqual(
    draft.claim,
    'Documentation files referencing deleted source files cause confusion — prune stale references in CI',
    'claim_refined must replace docs-scan composite claim'
  );
  // recommended_action: Step A had pre-existing value → NOT replaced by Step B (Step A authority)
  assert.strictEqual(draft.recommended_action[0], 'remove reference or restore file',
    'Step A non-empty recommended_action is preserved (Step A authority)');
});

test('ITEM-6-r2: empty claim_refined does not clobber draft.claim', () => {
  const draft = {
    title: 'Some title',
    claim: 'Some composite claim — detail here',
    confidence: 0.5,
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
  };
  const stepB = {
    claim_refined: '',  // empty — must not replace
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
  };
  mergeStepB(draft, stepB, { id: 'src_0' });
  assert.strictEqual(draft.claim, 'Some composite claim — detail here',
    'empty claim_refined must not replace draft.claim');
});
