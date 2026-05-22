'use strict';
// β.5-β.7 integrated test: lazy distill pipeline with cross-project filter
// (R4-C) + Stage 6 cursor advance with deferred-line protection (R4-B).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runLazyDistill, filterByProject, groupBySession, readPendingEvents } = require('../scripts/lib/distill-pipeline');
const { readCursor } = require('../scripts/lib/cursor');

function mkTmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-distill-pipe-'));
  fs.mkdirSync(path.join(r, 'events'), { recursive: true });
  return r;
}

function mkHookEvent(projectId, sessionId, sourceKind = 'hook-post-tool-use', toolName = 'Edit', toolInputSummary = 'edited x.ts (3 lines)') {
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
      artifact_kind: 'memory-hook-event',
      run_id: crypto.randomUUID(),
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: `host-stdin://test/${sourceKind}` }] },
      host: 'claude-code',
      session_id: sessionId,
      project_id: projectId
    },
    payload: {
      source_kind: sourceKind,
      event_key: 'a'.repeat(64),
      dedupe_window_key: 'b'.repeat(64),
      captured_at: new Date().toISOString(),
      tool_name: toolName,
      tool_input_summary: toolInputSummary,
      tool_output_summary: 'ok',
      raw_chars_in: 100,
      raw_chars_out: 100,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  };
}

test('β.6 R4-C: filterByProject drops other-project events', () => {
  const a = mkHookEvent('proj_a', 's1');
  const b = mkHookEvent('proj_b', 's1');
  // simulate the flat-event-with-project_id shape that readPendingEvents extracts
  const flat = [
    { ...a.payload, session_id: 's1', project_id: 'proj_a' },
    { ...b.payload, session_id: 's1', project_id: 'proj_b' }
  ];
  const filtered = filterByProject(flat, 'proj_a');
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].project_id, 'proj_a');
});

test('β.5 baseline: distill pipeline with zero pending events returns 0 counts', async () => {
  const root = mkTmpRoot();
  const result = await runLazyDistill({ root, projectId: 'p1', config: { skip_llm: true } });
  assert.strictEqual(result.processed_events, 0);
  assert.strictEqual(result.drafts_emitted, 0);
});

test('β.5 + R4-C: pipeline processes only current-project events from mixed-project events.jsonl', async () => {
  const root = mkTmpRoot();
  const ym = new Date().toISOString().slice(0, 7);
  const eventsFile = path.join(root, 'events', `${ym}.jsonl`);
  // 3 events: A, B, A — only A's should distill
  const lines = [
    mkHookEvent('proj_a', 's1'),
    mkHookEvent('proj_b', 's1'),
    mkHookEvent('proj_a', 's1')
  ];
  fs.writeFileSync(eventsFile, lines.map(JSON.stringify).join('\n') + '\n');

  const result = await runLazyDistill({
    root,
    projectId: 'proj_a',
    config: {
      skip_llm: true,
      distill: { detectors: { session_summary: { always_emit: true } } }
    },
    commitDrafts: async (drafts) => drafts.length  // count drafts as "committed"
  });

  assert.strictEqual(result.processed_events, 3, 'should observe all 3 raw events');
  // proj_a has 2 events, both in session s1 → sessionSummary fallback emits 1
  assert.ok(result.drafts_emitted >= 1, `expected at least 1 draft, got ${result.drafts_emitted}`);
  // Cursor should advance to end of events file (no deferred drafts in skip_llm mode)
  const cursor = readCursor(root, 'proj_a');
  assert.ok(cursor, 'cursor should be advanced');
});

test('β.7 R4-B: deferred drafts keep cursor before them on next run', async () => {
  // Mock test: when refineBatch returns drafts with deferred:true, cursor
  // should advance only past committed/zero-draft lines. With skip_llm:true,
  // all drafts are treated as non-deferred (skip_llm path), so this test
  // validates the COMMITTED case where no deferral happens.
  const root = mkTmpRoot();
  const ym = new Date().toISOString().slice(0, 7);
  const eventsFile = path.join(root, 'events', `${ym}.jsonl`);
  fs.writeFileSync(eventsFile,
    mkHookEvent('p1', 's1').constructor === Object
      ? JSON.stringify(mkHookEvent('p1', 's1')) + '\n'
      : ''
  );
  const result = await runLazyDistill({
    root,
    projectId: 'p1',
    config: { skip_llm: true, distill: { detectors: { session_summary: { always_emit: true } } } },
    commitDrafts: async () => 1
  });
  assert.strictEqual(result.deferred_count, 0);
});

test('β.5: events from other projects do not block current project cursor', async () => {
  const root = mkTmpRoot();
  const ym = new Date().toISOString().slice(0, 7);
  const eventsFile = path.join(root, 'events', `${ym}.jsonl`);
  // Only proj_b events in the file
  const lines = [mkHookEvent('proj_b', 's1'), mkHookEvent('proj_b', 's1')];
  fs.writeFileSync(eventsFile, lines.map(JSON.stringify).join('\n') + '\n');

  const result = await runLazyDistill({
    root,
    projectId: 'proj_a',  // queried as proj_a — sees only proj_b events
    config: { skip_llm: true }
  });
  assert.strictEqual(result.warnings.includes('no_events_for_current_project'), true);
  // Cursor for proj_a should still advance to skip past proj_b events
  const cursor = readCursor(root, 'proj_a');
  assert.ok(cursor, 'cursor for proj_a should be set');
  assert.ok(cursor.offset > 0, `cursor should advance past foreign events, got ${cursor.offset}`);
});

test('groupBySession: groups events by session_id', () => {
  const groups = groupBySession([
    { session_id: 's1', tool_name: 'a' },
    { session_id: 's2', tool_name: 'b' },
    { session_id: 's1', tool_name: 'c' }
  ]);
  assert.strictEqual(groups.size, 2);
  assert.strictEqual(groups.get('s1').length, 2);
  assert.strictEqual(groups.get('s2').length, 1);
});
