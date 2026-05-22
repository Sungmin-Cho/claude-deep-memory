'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  mapHookSession,
  patternDetector,
  failureDetector,
  decisionDetector,
  styleDetector,
  sessionSummary,
  DEFAULT_THRESHOLDS
} = require('../scripts/lib/distill-hook-session');

function mkEvent(sk, toolName, inputSummary, sessionId = 's1') {
  return {
    source_kind: sk,
    tool_name: toolName,
    tool_input_summary: inputSummary,
    session_id: sessionId
  };
}

// -- patternDetector ---------------------------------------------------------

test('patternDetector: detects repeated tool sequence', () => {
  const events = [
    mkEvent('hook-post-tool-use', 'Read', 'read a.ts'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited a.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Read', 'read b.ts'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited b.ts (5 lines)'),
    mkEvent('hook-post-tool-use', 'Read', 'read c.ts'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited c.ts (2 lines)')
  ];
  const drafts = patternDetector(events, DEFAULT_THRESHOLDS);
  assert.ok(drafts.length >= 1, `expected at least 1 pattern draft, got ${drafts.length}`);
  assert.strictEqual(drafts[0].memory_type, 'pattern');
});

test('patternDetector: empty input → 0 drafts', () => {
  assert.deepStrictEqual(patternDetector([], DEFAULT_THRESHOLDS), []);
});

// -- failureDetector ---------------------------------------------------------

test('failureDetector: tool-failure followed by Edit fix → 1 draft', () => {
  const events = [
    mkEvent('hook-tool-failure', 'Bash', 'bash: npm test (failed)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/x.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Bash', 'bash: npm test')
  ];
  const drafts = failureDetector(events, DEFAULT_THRESHOLDS);
  assert.strictEqual(drafts.length, 1);
  assert.strictEqual(drafts[0].memory_type, 'failure-case');
});

test('failureDetector: failure without fix within window → 0 drafts', () => {
  const events = [
    mkEvent('hook-tool-failure', 'Bash', 'failed'),
    mkEvent('hook-user-prompt', '', '')
  ];
  const drafts = failureDetector(events, DEFAULT_THRESHOLDS);
  assert.strictEqual(drafts.length, 0);
});

// -- decisionDetector --------------------------------------------------------

test('decisionDetector: ≥3 file edits in single prompt → architecture-decision', () => {
  const events = [
    mkEvent('hook-user-prompt', '', ''),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/a.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/b.ts (5 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/c.ts (2 lines)')
  ];
  const drafts = decisionDetector(events, DEFAULT_THRESHOLDS);
  assert.strictEqual(drafts.length, 1);
  assert.strictEqual(drafts[0].memory_type, 'architecture-decision');
});

test('decisionDetector: <3 file edits → 0 drafts', () => {
  const events = [
    mkEvent('hook-user-prompt', '', ''),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/a.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/b.ts (5 lines)')
  ];
  const drafts = decisionDetector(events, DEFAULT_THRESHOLDS);
  assert.strictEqual(drafts.length, 0);
});

// -- styleDetector -----------------------------------------------------------

test('styleDetector: ≥3 .ts file edits → coding-style draft', () => {
  const events = [
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/a.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/b.ts (5 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/c.ts (2 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited src/d.ts (4 lines)')
  ];
  const drafts = styleDetector(events, DEFAULT_THRESHOLDS);
  assert.ok(drafts.length >= 1);
  assert.strictEqual(drafts[0].memory_type, 'coding-style');
});

// -- sessionSummary ---------------------------------------------------------

test('sessionSummary: always emits 1 architecture-decision draft', () => {
  const events = [mkEvent('hook-session-start', '', '')];
  const d = sessionSummary(events);
  assert.strictEqual(d.memory_type, 'architecture-decision');
});

// -- mapHookSession orchestration -------------------------------------------

test('mapHookSession: zero-event input → empty array', () => {
  assert.deepStrictEqual(mapHookSession([], {}), []);
});

test('mapHookSession: no patterns + always_emit=true → fallback summary draft', () => {
  const events = [
    mkEvent('hook-session-start', '', ''),
    mkEvent('hook-user-prompt', '', '')
  ];
  const drafts = mapHookSession(events, { detectors: DEFAULT_THRESHOLDS });
  assert.strictEqual(drafts.length, 1);
  assert.strictEqual(drafts[0].title.startsWith('Session summary'), true);
});

test('mapHookSession: no patterns + always_emit=false → 0 drafts', () => {
  const cfg = {
    detectors: {
      ...DEFAULT_THRESHOLDS,
      session_summary: { always_emit: false }
    }
  };
  const events = [
    mkEvent('hook-session-start', '', ''),
    mkEvent('hook-user-prompt', '', '')
  ];
  const drafts = mapHookSession(events, cfg);
  assert.strictEqual(drafts.length, 0);
});

test('mapHookSession: combines drafts from multiple detectors', () => {
  const events = [
    mkEvent('hook-user-prompt', '', ''),
    mkEvent('hook-post-tool-use', 'Read', 'read a.ts'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited a.ts (3 lines)'),
    mkEvent('hook-post-tool-use', 'Read', 'read b.ts'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited b.ts (5 lines)'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited c.ts (2 lines)'),
    mkEvent('hook-tool-failure', 'Bash', 'failed'),
    mkEvent('hook-post-tool-use', 'Edit', 'edited fix.ts (1 line)')
  ];
  const drafts = mapHookSession(events, { detectors: DEFAULT_THRESHOLDS });
  // Expect drafts from multiple detectors (pattern + decision + style + failure)
  assert.ok(drafts.length >= 2, `expected multiple drafts, got ${drafts.length}`);
  const types = new Set(drafts.map(d => d.memory_type));
  assert.ok(types.size >= 2, `expected multiple memory_types, got ${[...types]}`);
});
