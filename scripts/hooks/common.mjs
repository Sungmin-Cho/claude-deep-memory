// scripts/hooks/common.mjs
// PR1-B/C/D/J + W4/W8 + Plan-Round-2 PR2-A/B/C/D integrated implementation.
// Shared helpers for the 6 Tier-1 hook scripts. Public exports:
//   - isCaptureEnabled(): boolean
//   - resolveCurrentProject(): string (project_id)
//   - normalizeAndAppend(sourceKind, hookPayload, hostHint): Promise<{...}>
//   - detectHost(): string

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const { redactString } = require('../lib/redact.js');
const { acquire, release } = require('../lib/lock.js');
const { detectHost: detectRuntimeHost } = require('../lib/runtime-context.js');

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

// ---- config -----------------------------------------------------------------

let configCache = null;  // { mtime, value }

function readConfig() {
  const cfgPath = path.join(DEEP_MEMORY_ROOT, 'config.yaml');
  try {
    const stat = fs.statSync(cfgPath);
    if (configCache && configCache.mtime === stat.mtimeMs) return configCache.value;
    const text = fs.readFileSync(cfgPath, 'utf8');
    // Anchored to a COLUMN-0 top-level capture: key so neither a sibling like
    // `other_capture:` (R4 N4) nor an indented/nested `capture:` (R5 N6) can
    // false-positive. `enabled:` must be the first indented child line.
    const enabled = /^capture:[ \t]*\r?\n[ \t]+enabled:[ \t]*true\b/m.test(text);
    configCache = { mtime: stat.mtimeMs, value: { capture: { enabled } } };
    return configCache.value;
  } catch (e) {
    return { capture: { enabled: false } };  // safe default — missing config means OFF
  }
}

export function isCaptureEnabled() {
  return readConfig().capture.enabled === true;
}

export function isEagerDistillEnabled() {
  const cfgPath = path.join(DEEP_MEMORY_ROOT, 'config.yaml');
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
    // Column-0 top-level capture: (R4 N4 + R5 N6), block-scoped: only indented
    // child lines may sit between `capture:` and `eager_distill:` so a later
    // top-level section's eager_distill cannot match.
    return /^capture:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+eager_distill:[ \t]*true\b/m.test(text);
  } catch {
    return false;
  }
}

// ---- project resolution -----------------------------------------------------
// Every hook invocation computes one full-schema, physical-root-bound scope.
const { resolveProjectScope } = require('../lib/project-resolver.js');

// ---- tool input/output summarization (PR1-J + Codex adv MED-2) -------------

function summarizeToolInput(toolInput) {
  if (!toolInput) return '';
  if (typeof toolInput === 'string') return toolInput.slice(0, 200);
  if (toolInput.file_path) {
    const op = toolInput.old_string && toolInput.new_string ? 'edited' : 'wrote';
    const lines = toolInput.new_string ? toolInput.new_string.split('\n').length : '?';
    return `${op} ${toolInput.file_path} (${lines} lines)`;
  }
  if (toolInput.command) return `bash: ${toolInput.command.slice(0, 120)}`;
  if (toolInput.pattern) return `grep: ${toolInput.pattern.slice(0, 80)}`;
  if (toolInput.todos) return `todos: ${toolInput.todos.length} items`;
  if (toolInput.subject) return `task: ${toolInput.subject.slice(0, 100)}`;
  if (toolInput.query) return `query: ${toolInput.query.slice(0, 100)}`;
  if (toolInput.url) return `fetch: ${toolInput.url.slice(0, 150)}`;
  return JSON.stringify(toolInput).slice(0, 200);
}

function summarizeToolOutput(toolOutput) {
  if (!toolOutput) return '';
  const s = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
  return s.slice(0, 300);
}

// ---- dedupe window (PR1-J + Plan-Round-2 PR2-C raw-essence dedupe) ---------

function checkDedupeWindow(dedupeKey, projectId) {
  const indexPath = path.join(DEEP_MEMORY_ROOT, '.dedupe-window', `${projectId}.jsonl`);
  if (!fs.existsSync(indexPath)) return false;
  try {
    const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const line of lines) {
      const [key, atStr] = line.split('|');
      if (key === dedupeKey && parseInt(atStr, 10) >= cutoff) return true;
    }
  } catch {}
  return false;
}

function recordDedupeWindow(dedupeKey, projectId) {
  const indexDir = path.join(DEEP_MEMORY_ROOT, '.dedupe-window');
  fs.mkdirSync(indexDir, { recursive: true });
  fs.appendFileSync(path.join(indexDir, `${projectId}.jsonl`), `${dedupeKey}|${Date.now()}\n`);
}

// ---- normalize + append (PR2-B async, PR2-A node invocation, PR2-C raw essence)

export async function normalizeAndAppend(sourceKind, hookPayload, hostHint) {
  if (!isCaptureEnabled()) return { skipped: true, reason: 'capture-disabled' };

  const projectScope = resolveProjectScope(process.env.PROJECT_CWD || null);
  if (projectScope.scope !== 'project' || !projectScope.projectId) {
    return { skipped: true, reason: projectScope.warning || 'project_profile_untrusted' };
  }
  const projectId = projectScope.projectId;
  const toolInputSummary = summarizeToolInput(hookPayload.tool_input);
  const toolOutputSummary = summarizeToolOutput(hookPayload.tool_output);

  // Pass 0: redact the assembled normalized payload.
  const preRedacted = {
    source_kind: sourceKind,
    session_id: hookPayload.session_id || 'unknown',
    project_id: projectId,
    tool_name: hookPayload.tool_name || '',
    tool_input_summary: toolInputSummary,
    tool_output_summary: toolOutputSummary,
  };
  const redactedJson = redactString(JSON.stringify(preRedacted));
  const redactedPayload = JSON.parse(redactedJson);

  // PR2-C: dedupe by HASH OF RAW (redacted) tool_input/output essence — not lossy summary.
  const rawIn = JSON.stringify(hookPayload.tool_input || '');
  const rawOut = JSON.stringify(hookPayload.tool_output || '').slice(0, 1024);
  const redactedIn = redactString(rawIn);
  const redactedOut = redactString(rawOut);
  const essence = `${sourceKind}|${redactedPayload.session_id}|${redactedPayload.tool_name}|${redactedIn}|${redactedOut}`;
  const dedupeKey = crypto.createHash('sha256').update(essence).digest('hex');

  // IMPL-R1-I — initial dedupe check OUTSIDE lock for the optimistic fast-path.
  // A re-check INSIDE the lock (below) closes the TOCTOU race. The fast-path
  // saves lock acquisition cost when the dedupe is obvious.
  if (checkDedupeWindow(dedupeKey, projectId)) {
    return { skipped: true, reason: 'duplicate-within-5min', dedupe_window_key: dedupeKey };
  }

  const capturedAt = new Date().toISOString();
  const eventKey = crypto.createHash('sha256').update(essence + '|' + capturedAt).digest('hex');

  const record = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: pkg.version,
      artifact_kind: 'memory-hook-event',
      run_id: crypto.randomUUID(),
      generated_at: capturedAt,
      schema: { name: 'memory-hook-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: `host-stdin://${hostHint}/${sourceKind}` }] },
      host: hostHint,
      session_id: redactedPayload.session_id,
      project_id: projectId
    },
    payload: {
      source_kind: sourceKind,
      event_key: eventKey,
      dedupe_window_key: dedupeKey,
      captured_at: capturedAt,
      tool_name: redactedPayload.tool_name,
      tool_input_summary: redactedPayload.tool_input_summary,
      tool_output_summary: redactedPayload.tool_output_summary,
      raw_chars_in: rawIn.length,
      raw_chars_out: rawOut.length,
      redaction: { rules_matched: 0, chars_masked: 0, passes: ['pass0'] }
    }
  };

  const ym = capturedAt.slice(0, 7);
  const eventsFile = path.join(DEEP_MEMORY_ROOT, 'events', `${ym}.jsonl`);
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });

  // PR2-B: acquire is async + needs .lock dir path.
  const lockDir = path.join(DEEP_MEMORY_ROOT, '.lock');
  let lockHandle;
  try {
    lockHandle = await acquire(lockDir);
  } catch (e) {
    // A stale lock (holder crashed >5min ago) makes acquire() THROW. In the
    // capture path that must not propagate — otherwise every subsequent
    // tool-use hook fails until the user runs /deep-memory-audit --unlock.
    // Skip this one event with a warning and let the session continue; the
    // durable events tail is untouched and re-capture resumes once the lock
    // is broken. We do NOT auto-break here (that stays a deliberate audit op).
    if (e && e.code === 'STALE_LOCK') {
      console.error(`[deep-memory] capture skipped (stale lock): ${e.message}`);
      return { skipped: true, reason: 'stale-lock', warning: e.message };
    }
    // Any other acquire failure (e.g. retries exhausted) is likewise non-fatal
    // for capture — drop the event rather than crash the hook.
    console.error(`[deep-memory] capture skipped (lock unavailable): ${e && e.message}`);
    return { skipped: true, reason: 'lock-unavailable', warning: e && e.message };
  }
  try {
    // IMPL-R1-I — TOCTOU close: re-check dedupe INSIDE the lock. If a
    // concurrent hook beat us in between the optimistic check and lock
    // acquire, drop our write and return skipped.
    if (checkDedupeWindow(dedupeKey, projectId)) {
      return { skipped: true, reason: 'duplicate-within-5min-lock-race', dedupe_window_key: dedupeKey };
    }
    // PR1-W4 fix: open/write/fsync/close — no fd leak.
    const fd = fs.openSync(eventsFile, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    recordDedupeWindow(dedupeKey, projectId);
  } finally {
    release(lockHandle);
  }

  return { appended: true, event_key: eventKey };
}

// ---- host detection (PR1-W8) ------------------------------------------------

export function detectHost() {
  return detectRuntimeHost(process.env);
}
