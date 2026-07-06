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
 * Read pending events from events past the project's cursor.
 * Implements §4.5 Stage 1a + Stage 1b WITH:
 *   - IMPL-R1-F (Opus 🔴 #4): cross-month rollover — scans all month files
 *     lex-≥ cursor.file forward through to current month.
 *   - IMPL-R1-E (Opus 🔴 #3): per-event `_line_start_offset` so deferred-line
 *     cursor advance lands BEFORE (not after) the deferred line.
 *
 * Returns { events: [...], lastByteOffset, file } where (file, lastByteOffset)
 * is the cursor-target after the read (EOF of last scanned file or current
 * cursor location if no events read).
 */
function readPendingEvents(root, projectId) {
  const cursor = readCursor(root, projectId);
  const ym = new Date().toISOString().slice(0, 7);
  const currentMonthFile = `${ym}.jsonl`;
  const eventsDir = path.join(root, 'events');

  const startFile = cursor ? cursor.file : currentMonthFile;
  const startOffset = cursor ? cursor.offset : 0;

  if (!fs.existsSync(eventsDir)) {
    return { events: [], lastByteOffset: startOffset, file: startFile };
  }

  // IMPL-R1-F: enumerate month files lex-≥ startFile (filenames are
  // YYYY-MM.jsonl so lex order == chronological order).
  const allFiles = fs.readdirSync(eventsDir)
    .filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
  const targetFiles = allFiles.filter(f => f >= startFile);

  if (targetFiles.length === 0) {
    return { events: [], lastByteOffset: startOffset, file: startFile };
  }

  const events = [];
  let lastFile = startFile;
  let lastOffset = startOffset;

  for (const file of targetFiles) {
    const filePath = path.join(eventsDir, file);
    const stat = fs.statSync(filePath);
    const fileStartOffset = (file === startFile) ? startOffset : 0;
    if (fileStartOffset >= stat.size) {
      lastFile = file;
      lastOffset = fileStartOffset;
      continue;
    }
    const buf = fs.readFileSync(filePath);
    const tail = buf.slice(fileStartOffset).toString('utf8');
    // Keep empty trailing entries to preserve offset math; filter by
    // line.trim() emptiness instead of split.filter(Boolean) which collapses.
    const rawLines = tail.split('\n');
    let cumulative = fileStartOffset;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const isLastSegment = (i === rawLines.length - 1);
      if (line.length === 0) {
        if (!isLastSegment) cumulative += 1;  // empty line followed by \n
        continue;
      }
      const lineStart = cumulative;
      // If this is the last segment AND the original tail did not end with \n,
      // the line is a partial write — do NOT consume it (concurrent appender
      // may be mid-write).
      const hasTrailingNewline = !isLastSegment || tail.endsWith('\n');
      const lineEnd = cumulative + Buffer.byteLength(line, 'utf8') + (hasTrailingNewline ? 1 : 0);
      if (!hasTrailingNewline) break;  // partial line — stop, don't advance cursor past it
      cumulative = lineEnd;
      const r = dispatch(line);
      if (r.routed === 'memory-hook-event' && r.valid) {
        const obj = JSON.parse(line);
        events.push({
          ...obj.payload,
          session_id: obj.envelope.session_id,
          project_id: obj.envelope.project_id,
          host: obj.envelope.host,
          // IMPL-R1-E: BOTH start + end offsets for correct R4-B deferral.
          _file: file,
          _line_start_offset: lineStart,
          _line_end_offset: lineEnd
        });
      }
    }
    lastFile = file;
    lastOffset = cumulative;
  }

  return { events, lastByteOffset: lastOffset, file: lastFile };
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

  // β.7 + R4-B + IMPL-R1-E — Stage 6 cursor advance "processed" semantics.
  // A line is "processed" iff its drafts were either committed OR explicitly
  // zero-draft. Token-cap-deferred drafts hold the cursor BEFORE them.
  const deferredCount = refined.filter(r => r.deferred === true).length;

  let cursorFile = file;
  let lastFullyProcessedLineEnd = lastByteOffset;
  if (deferredCount > 0) {
    const deferredSessions = new Set();
    for (const r of refined) {
      if (r.deferred && r.session_id) deferredSessions.add(r.session_id);
    }
    // IMPL-R1-E + R4 #1: the hold point is a (file, offset) PAIR — offsets are
    // per-file, so comparing raw offsets across month files corrupts the cursor
    // on rollover (an old-file offset written under the newest filename skips
    // the old file's deferred events entirely). Track the EARLIEST deferred
    // event by (file lex ≡ chronological, then _line_start_offset — the byte
    // BEFORE the deferred line) so the cursor lands strictly upstream of it
    // and the next readPendingEvents re-reads that line.
    let earliest = null;
    for (const e of ourEvents) {
      if (!deferredSessions.has(e.session_id)) continue;
      if (!earliest || e._file < earliest._file ||
          (e._file === earliest._file && e._line_start_offset < earliest._line_start_offset)) {
        earliest = e;
      }
    }
    if (earliest) {
      if (earliest._file === cursorFile) {
        lastFullyProcessedLineEnd = Math.min(earliest._line_start_offset, lastByteOffset);
      } else {
        cursorFile = earliest._file;
        lastFullyProcessedLineEnd = earliest._line_start_offset;
      }
    }
  }

  // Stage 6 — commit drafts (callback-driven for testability)
  const draftsEmitted = refined.length - deferredCount;
  let cardsCommitted = 0;
  if (commitDrafts) {
    try {
      cardsCommitted = await commitDrafts(refined.filter(r => !r.deferred), { projectId, root });
    } catch (e) {
      warnings.push(`commitDrafts threw: ${e.message}; cards may be partially committed`);
    }
  }

  // β.7 + P0 lossless-cursor invariant — advance the cursor ONLY when EVERY
  // emitted draft was durably accounted for (committed OR idempotently
  // de-duplicated; `commitDrafts` returns that count), or there was nothing to
  // commit (every line was zero-draft / all drafts deferred). Anything less —
  // no card-writer wired (production callers pass no `commitDrafts`),
  // `commitDrafts` threw, or a PARTIAL commit (accounted < emitted, R2 #2) —
  // holds the cursor so the events remain pending for a later re-distill
  // instead of being silently skipped (the capture→distill data-loss bug).
  const cursorSafeToAdvance = cardsCommitted >= draftsEmitted;
  let cursorAdvancedTo = null;
  if (cursorSafeToAdvance) {
    advanceTo(root, projectId, cursorFile, lastFullyProcessedLineEnd);
    cursorAdvancedTo = `${cursorFile}:${lastFullyProcessedLineEnd}`;
  } else {
    warnings.push(
      `cursor_held: ${draftsEmitted} draft(s) emitted but only ${cardsCommitted} durably accounted ` +
      `(no card-writer wired, or partial commit) — events kept pending to avoid loss`
    );
  }

  return {
    processed_events: rawEvents.length,
    drafts_emitted: draftsEmitted,
    cards_committed: cardsCommitted,
    deferred_count: deferredCount,
    cursor_advanced_to: cursorAdvancedTo,
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
