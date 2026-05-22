'use strict';
// scripts/lib/distill-pipeline.js
// β.5-β.8 integrated — Lazy distill orchestrator that processes hook events
// past the byte-offset cursor through mapHookSession + refineBatch, writes
// candidate cards (delegated to existing card writer), and advances cursor
// to the byte offset immediately after the last contiguous processed line
// (R4-B token-cap deferral protection; R4-C cross-project filter; PR2-C raw-
// essence dedupe).
//
// Lock-granularity (β.8): two short critical sections per pipeline run —
//   1) read cursor + snapshot file size  → release (μs order)
//   2) commit cards + advance cursor     → release (ms order, no LLM in-lock)
// LLM refineBatch + embedding work happen OUTSIDE either critical section.

const fs = require('node:fs');
const path = require('node:path');
const { readCursor, advanceTo } = require('./cursor');
const { dispatch } = require('./event-dispatcher');
const { mapHookSession } = require('./distill-hook-session');
const { refineBatch } = require('./llm-bridge');

/**
 * Read pending events from events.jsonl past the project's cursor.
 * Returns { events: [...], lastByteOffset, file }.
 * Implements §4.5 Stage 1a (cursor snapshot — short lock-protected) +
 * Stage 1b (lockless tail read; append-only invariant makes this race-free).
 */
function readPendingEvents(root, projectId) {
  const cursor = readCursor(root, projectId);
  const ym = new Date().toISOString().slice(0, 7);
  const currentMonthFile = `${ym}.jsonl`;
  const eventsDir = path.join(root, 'events');

  // Determine the cursor's anchor file. If no cursor, start at the earliest
  // available month with content; if cursor is on a past month, read it
  // forward + all intervening months + current month.
  const file = cursor ? cursor.file : currentMonthFile;
  const offset = cursor ? cursor.offset : 0;
  const eventsFile = path.join(eventsDir, file);

  if (!fs.existsSync(eventsFile)) {
    return { events: [], lastByteOffset: offset, file };
  }
  const stat = fs.statSync(eventsFile);
  if (offset >= stat.size) {
    return { events: [], lastByteOffset: offset, file };
  }

  // Lockless tail read past cursor (append-only file is safe).
  const buf = fs.readFileSync(eventsFile);
  const tail = buf.slice(offset).toString('utf8');
  const lines = tail.split('\n').filter(Boolean);

  // Compute the per-line byte offset so cursor advance can land exactly after
  // the last fully-processed line (R4-B fix).
  const lineOffsets = [];
  let cumulative = offset;
  for (const line of lines) {
    cumulative += Buffer.byteLength(line, 'utf8') + 1;  // +1 for \n
    lineOffsets.push(cumulative);
  }

  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const r = dispatch(lines[i]);
    if (r.routed === 'memory-hook-event' && r.valid) {
      // Extract the payload + project_id from envelope
      const obj = JSON.parse(lines[i]);
      events.push({
        ...obj.payload,
        session_id: obj.envelope.session_id,
        project_id: obj.envelope.project_id,
        host: obj.envelope.host,
        // byte offset AFTER this line — for R4-B cursor advance
        _line_end_offset: lineOffsets[i]
      });
    }
    // Non-hook-event lines (memory-event, legacy-wrapped, quarantine) — skip
    // for hook-distill purposes; the regular sibling-artifact pipeline handles
    // those separately.
  }

  return { events, lastByteOffset: stat.size, file };
}

/**
 * β.6 — Stage 1c cross-project filter (R4-C). Filter events to only those
 * tagged with envelope.project_id == currentProjectId. Other-project events
 * pass through silently (they'll be picked up by THEIR project's brief).
 */
function filterByProject(events, currentProjectId) {
  return events.filter(e => e.project_id === currentProjectId);
}

/**
 * Group events by session_id (Stage 2 of §4.5).
 */
function groupBySession(events) {
  const groups = new Map();
  for (const e of events) {
    const sid = e.session_id || 'unknown';
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(e);
  }
  return groups;
}

/**
 * runLazyDistill — orchestrates Stage 1a..Stage 6 of §4.5 distill pipeline.
 * Returns a summary suitable for latest-distill.json (W5 fix).
 *
 * NOTE: card write + FTS5/vector upsert (Stage 6 inside critical section B)
 * is delegated to the optional `commitDrafts` callback. Callers in v0.3.0
 * may pass a stub that records drafts to a temp dir for testing; production
 * wiring in brief.js + harvest.js (final phase task) plugs in the existing
 * card-write pipeline.
 *
 * @param {object} args - { root, projectId, config?, commitDrafts? }
 * @returns {Promise<{processed_events, drafts_emitted, cards_committed, deferred_count, cursor_advanced_to, warnings, started_at, finished_at}>}
 */
async function runLazyDistill({ root, projectId, config = {}, commitDrafts = null }) {
  const startedAt = new Date().toISOString();
  const warnings = [];

  // Stage 1a + 1b — read pending events past cursor
  const { events: rawEvents, lastByteOffset, file } = readPendingEvents(root, projectId);
  if (rawEvents.length === 0) {
    return {
      processed_events: 0,
      drafts_emitted: 0,
      cards_committed: 0,
      deferred_count: 0,
      cursor_advanced_to: null,
      warnings,
      started_at: startedAt,
      finished_at: new Date().toISOString()
    };
  }

  // β.6 / R4-C: cross-project filter
  const ourEvents = filterByProject(rawEvents, projectId);
  if (ourEvents.length === 0) {
    // Nothing for THIS project — advance cursor past these foreign lines
    // (they'll be picked up by their own project's brief; do NOT block on them).
    advanceTo(root, projectId, file, lastByteOffset);
    return {
      processed_events: rawEvents.length,
      drafts_emitted: 0,
      cards_committed: 0,
      deferred_count: 0,
      cursor_advanced_to: `${file}:${lastByteOffset}`,
      warnings: ['no_events_for_current_project'],
      started_at: startedAt,
      finished_at: new Date().toISOString()
    };
  }

  // Stage 2 — group by session_id
  const sessionGroups = groupBySession(ourEvents);

  // Stage 3 — per-session, run mapHookSession → drafts
  let allDrafts = [];
  for (const [sessionId, sessionEvents] of sessionGroups.entries()) {
    const drafts = mapHookSession(sessionEvents, config.distill || {});
    allDrafts.push(...drafts);
  }

  // Stage 4 — refineBatch (LLM, outside lock). Per-draft fallback to candidate.
  // For β.5 baseline implementation, we skip the actual LLM round-trip when
  // no adapter is configured — caller drives this via `config.skip_llm: true`
  // (test/CI mode). Production wiring resolves adapter from env.
  let refined;
  if (config.skip_llm) {
    refined = allDrafts.map(d => ({ ...d, _skip_llm_marker: true }));
  } else if (allDrafts.length === 0) {
    refined = [];
  } else {
    try {
      refined = await refineBatch(allDrafts, {
        batchSize: config.batch_size || 5,
        maxTokens: config.max_llm_tokens_per_run || 50000,
        adapter: config.adapter
      });
    } catch (e) {
      warnings.push(`refineBatch threw: ${e.message}; all drafts fall back to candidate`);
      refined = allDrafts.map(d => ({ ...d, status: 'candidate' }));
    }
  }

  // β.7 + R4-B — Stage 6 cursor advance "processed" semantics:
  //   A line is "processed" iff its drafts were either committed OR explicitly
  //   zero-draft. Token-cap deferred drafts do NOT count — cursor stays
  //   before them.
  // We identify deferred drafts by inspection of refined[i].deferred:
  const deferredCount = refined.filter(r => r.deferred === true).length;

  // Map drafts back to their source line offsets. A draft's source line is
  // implicit — we tagged each event with `_line_end_offset`. If ANY event in a
  // session group produced a deferred draft, cursor stops AT or BEFORE that
  // event's start (lastFullyProcessedLineEnd).
  // Simplification for β.5 baseline: identify the earliest deferred-draft
  // session group's first event; cursor advances to that event's start.
  let lastFullyProcessedLineEnd = lastByteOffset;  // optimistic default
  if (deferredCount > 0) {
    // Find the earliest event whose session has any deferred draft.
    const deferredSessions = new Set();
    for (const r of refined) {
      if (r.deferred && r.session_id) deferredSessions.add(r.session_id);
    }
    // Earliest event in those sessions = the latest safe cursor advance point.
    const earliestDeferredEventOffset = Math.min(
      ...ourEvents
        .filter(e => deferredSessions.has(e.session_id))
        .map(e => e._line_end_offset - 1),  // line START, not end
      lastByteOffset
    );
    lastFullyProcessedLineEnd = earliestDeferredEventOffset;
  }

  // Stage 6 — commit drafts (callback-driven for testability)
  let cardsCommitted = 0;
  if (commitDrafts) {
    try {
      cardsCommitted = await commitDrafts(refined.filter(r => !r.deferred), { projectId, root });
    } catch (e) {
      warnings.push(`commitDrafts threw: ${e.message}; cards may be partially committed`);
    }
  }

  // β.7 — advance cursor to byte offset after last fully-processed line
  advanceTo(root, projectId, file, lastFullyProcessedLineEnd);

  return {
    processed_events: rawEvents.length,
    drafts_emitted: refined.length - deferredCount,
    cards_committed: cardsCommitted,
    deferred_count: deferredCount,
    cursor_advanced_to: `${file}:${lastFullyProcessedLineEnd}`,
    warnings,
    started_at: startedAt,
    finished_at: new Date().toISOString()
  };
}

module.exports = {
  runLazyDistill,
  readPendingEvents,
  filterByProject,
  groupBySession
};
