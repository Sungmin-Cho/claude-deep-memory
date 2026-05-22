'use strict';
// scripts/lib/distill-hook-session.js
// β.4 — mapHookSession + 5 deterministic detectors per spec §4.2.
//
// Input:  sessionEvents — array of memory-hook-event payload objects from
//         events/YYYY-MM.jsonl filtered to a single session_id.
// Output: array of Step A event-drafts (0..N) ready for Pass 1 redact + Step B
//         LLM refine. Each draft is a partial memory-card with required fields:
//         { memory_type, title, claim, evidence_summary, search_keywords, tags,
//           session_id, applicability, non_applicability, recommended_action }
//
// Determinism: no LLM. All thresholds are config-driven (config.yaml#distill.detectors).
// Zero output is a valid result (means: no meaningful pattern in this session).

const DEFAULT_THRESHOLDS = {
  pattern: { min_repetitions: 2, sequence_window: 5 },
  failure: { retry_window_events: 3 },
  decision: { min_files_changed: 3 },
  style: { min_pattern_matches: 3 },
  session_summary: { always_emit: true }
};

/**
 * patternDetector — same tool-sequence repeated ≥ min_repetitions times.
 * Uses sliding window of length 1..sequence_window over tool_name sequence.
 * If a window contents (joined by '|') appears ≥ min_repetitions times, emit
 * one 'pattern' draft.
 */
function patternDetector(events, cfg) {
  const t = cfg.pattern || DEFAULT_THRESHOLDS.pattern;
  const drafts = [];
  if (events.length < t.min_repetitions * 2) return drafts;
  const toolSeq = events.map(e => e.tool_name || '').filter(Boolean);
  if (toolSeq.length < 2) return drafts;
  const counts = new Map();
  for (let win = 2; win <= Math.min(t.sequence_window, toolSeq.length); win++) {
    for (let i = 0; i + win <= toolSeq.length; i++) {
      const key = toolSeq.slice(i, i + win).join('|');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const recurring = [...counts.entries()]
    .filter(([_, c]) => c >= t.min_repetitions)
    .sort((a, b) => b[1] - a[1]);
  if (recurring.length > 0) {
    const [seq, occurrences] = recurring[0];
    drafts.push({
      memory_type: 'pattern',
      title: `Repeated tool sequence: ${seq}`,
      claim: `The tool sequence "${seq}" repeated ${occurrences} times in this session, suggesting an established workflow pattern.`,
      evidence_summary: [`Tool sequence "${seq}" occurred ${occurrences} times within ${events.length} events`],
      search_keywords: ['pattern', 'tool-sequence', ...seq.split('|').slice(0, 3)],
      tags: ['hook-detected', 'pattern-detector'],
      session_id: events[0]?.session_id || 'unknown',
      applicability: [],
      non_applicability: [],
      recommended_action: []
    });
  }
  return drafts;
}

/**
 * failureDetector — PostToolUseFailure followed within retry_window by Edit/Bash retry.
 */
function failureDetector(events, cfg) {
  const t = cfg.failure || DEFAULT_THRESHOLDS.failure;
  const drafts = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].source_kind !== 'hook-tool-failure') continue;
    // Look at next retry_window events for fix attempt
    const failedTool = events[i].tool_name || '';
    const windowEnd = Math.min(i + 1 + t.retry_window_events, events.length);
    let fixedBy = null;
    for (let j = i + 1; j < windowEnd; j++) {
      const sk = events[j].source_kind;
      const tn = events[j].tool_name || '';
      if (sk === 'hook-post-tool-use' && (tn === 'Edit' || tn === 'Bash' || tn === 'Write')) {
        fixedBy = tn;
        break;
      }
    }
    if (fixedBy) {
      drafts.push({
        memory_type: 'failure-case',
        title: `${failedTool} failure recovered by ${fixedBy}`,
        claim: `A ${failedTool} tool failure was recovered within ${t.retry_window_events} events via ${fixedBy}.`,
        evidence_summary: [
          `Failure event: ${events[i].tool_input_summary || ''}`,
          `Fix event: ${events[i + 1]?.tool_input_summary || ''}`
        ],
        search_keywords: ['failure-case', 'recovery', failedTool, fixedBy],
        tags: ['hook-detected', 'failure-detector'],
        session_id: events[0]?.session_id || 'unknown',
        applicability: [],
        non_applicability: [],
        recommended_action: [`When ${failedTool} fails, attempt ${fixedBy} as recovery.`]
      });
    }
  }
  return drafts;
}

/**
 * decisionDetector — multi-file edit (≥ min_files_changed files in a session
 * group bounded by UserPromptSubmit events).
 */
function decisionDetector(events, cfg) {
  const t = cfg.decision || DEFAULT_THRESHOLDS.decision;
  const drafts = [];
  // Group events by UserPromptSubmit boundaries
  const groups = [];
  let current = [];
  for (const e of events) {
    if (e.source_kind === 'hook-user-prompt' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) groups.push(current);

  for (const group of groups) {
    const editFiles = new Set();
    for (const e of group) {
      if (e.source_kind !== 'hook-post-tool-use') continue;
      // tool_input_summary like "edited src/auth.ts (12 lines)" or "wrote src/x.ts (5 lines)"
      const m = (e.tool_input_summary || '').match(/^(?:edited|wrote)\s+([^\s(]+)/);
      if (m) editFiles.add(m[1]);
    }
    if (editFiles.size >= t.min_files_changed) {
      const fileList = [...editFiles].slice(0, 10);
      drafts.push({
        memory_type: 'architecture-decision',
        title: `Multi-file change (${editFiles.size} files)`,
        claim: `A single user prompt resulted in edits across ${editFiles.size} files, suggesting an architecture-level change.`,
        evidence_summary: fileList.map(f => `Edited: ${f}`).slice(0, 5),
        search_keywords: ['multi-file', 'architecture-decision', 'refactor'],
        tags: ['hook-detected', 'decision-detector'],
        session_id: events[0]?.session_id || 'unknown',
        applicability: [],
        non_applicability: [],
        recommended_action: []
      });
    }
  }
  return drafts;
}

/**
 * styleDetector — repeated naming/format pattern in Edit ops' new_string content.
 * Heuristic: if min_pattern_matches edits share a common token pattern (e.g.
 * camelCase function names), emit a coding-style draft. Lightweight pass:
 * detect repeated identifier-naming style via simple regex sampling of
 * tool_input_summary lines.
 */
function styleDetector(events, cfg) {
  const t = cfg.style || DEFAULT_THRESHOLDS.style;
  const drafts = [];
  // Sample tool_input_summaries from Edit/Write events and look for shared file extension + edit verb consistency
  const editSummaries = events
    .filter(e => e.source_kind === 'hook-post-tool-use' && /^(?:edited|wrote)/.test(e.tool_input_summary || ''))
    .map(e => e.tool_input_summary || '');
  if (editSummaries.length < t.min_pattern_matches) return drafts;
  // Detect repeated extension (e.g. all .ts files)
  const extCounts = new Map();
  for (const s of editSummaries) {
    const m = s.match(/\.(\w+)\s/);
    if (m) extCounts.set(m[1], (extCounts.get(m[1]) || 0) + 1);
  }
  for (const [ext, count] of extCounts.entries()) {
    if (count >= t.min_pattern_matches) {
      drafts.push({
        memory_type: 'coding-style',
        title: `Consistent .${ext} edits (${count} events)`,
        claim: `This session shows consistent editing within .${ext} files (${count} edits), suggesting a focused coding-style context.`,
        evidence_summary: editSummaries.slice(0, 3),
        search_keywords: ['coding-style', `${ext}-file`, 'edit-pattern'],
        tags: ['hook-detected', 'style-detector'],
        session_id: events[0]?.session_id || 'unknown',
        applicability: [`File extension: .${ext}`].length > 0 ? [{ value: `File extension: .${ext}`, source_id: 'src_1', confidence: 0.5 }] : [],
        non_applicability: [],
        recommended_action: []
      });
    }
  }
  return drafts;
}

/**
 * sessionSummary — fallback emitter. Always-emit (configurable) generates
 * 1 architecture-decision card per session capturing the session's broad
 * shape so even sessions without specific patterns leave a trace.
 */
function sessionSummary(events) {
  const toolCount = events.filter(e => e.source_kind === 'hook-post-tool-use').length;
  const sessionId = events[0]?.session_id || 'unknown';
  return {
    memory_type: 'architecture-decision',
    title: `Session summary (${events.length} events, ${toolCount} tool calls)`,
    claim: `Session ${sessionId} processed ${events.length} hook events including ${toolCount} tool invocations.`,
    evidence_summary: [`Events: ${events.length}`, `Tool calls: ${toolCount}`],
    search_keywords: ['session-summary', 'architecture-decision'],
    tags: ['hook-detected', 'session-summary'],
    session_id: sessionId,
    applicability: [],
    non_applicability: [],
    recommended_action: []
  };
}

/**
 * mapHookSession — orchestrates 5 detectors + sessionSummary fallback.
 * @param {Array<object>} sessionEvents - events filtered to single session_id
 * @param {object} cfg - distill.detectors thresholds from config.yaml
 * @returns {Array<object>} event-drafts (0..N)
 */
function mapHookSession(sessionEvents, cfg) {
  if (!Array.isArray(sessionEvents) || sessionEvents.length === 0) return [];
  const thresholds = cfg && cfg.detectors ? cfg.detectors : DEFAULT_THRESHOLDS;
  const drafts = [];
  drafts.push(...patternDetector(sessionEvents, thresholds));
  drafts.push(...failureDetector(sessionEvents, thresholds));
  drafts.push(...decisionDetector(sessionEvents, thresholds));
  drafts.push(...styleDetector(sessionEvents, thresholds));
  const summaryCfg = thresholds.session_summary || DEFAULT_THRESHOLDS.session_summary;
  if (drafts.length === 0 && summaryCfg.always_emit) {
    drafts.push(sessionSummary(sessionEvents));
  }
  return drafts;
}

module.exports = {
  mapHookSession,
  // Exports for unit testing of individual detectors:
  patternDetector,
  failureDetector,
  decisionDetector,
  styleDetector,
  sessionSummary,
  DEFAULT_THRESHOLDS
};
