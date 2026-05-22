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
const { redactString } = require('../lib/redact.js');
const { acquire, release } = require('../lib/lock.js');

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

// ---- config -----------------------------------------------------------------

let configCache = null;  // { mtime, value }

function readConfig() {
  const cfgPath = path.join(DEEP_MEMORY_ROOT, 'config.yaml');
  try {
    const stat = fs.statSync(cfgPath);
    if (configCache && configCache.mtime === stat.mtimeMs) return configCache.value;
    const text = fs.readFileSync(cfgPath, 'utf8');
    const enabled = /capture:\s*\n\s*enabled:\s*true/.test(text);  // simple YAML probe
    configCache = { mtime: stat.mtimeMs, value: { capture: { enabled } } };
    return configCache.value;
  } catch (e) {
    return { capture: { enabled: false } };  // safe default — missing config means OFF
  }
}

export function isCaptureEnabled() {
  return readConfig().capture.enabled === true;
}

// ---- project resolution (PR1-C) --------------------------------------------

export function resolveCurrentProject() {
  const cwd = process.env.PROJECT_CWD || process.cwd();
  const profilePath = path.join(cwd, '.deep-memory', 'project-profile.json');
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.project_id) return profile.project_id;
  } catch {
    // fall through to derived id
  }
  return 'proj_' + crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

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

  const projectId = resolveCurrentProject();
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

  // 5-min sliding window dedup.
  if (checkDedupeWindow(dedupeKey, projectId)) {
    return { skipped: true, reason: 'duplicate-within-5min', dedupe_window_key: dedupeKey };
  }

  const capturedAt = new Date().toISOString();
  const eventKey = crypto.createHash('sha256').update(essence + '|' + capturedAt).digest('hex');

  const record = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.3.0',
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
  const lockHandle = await acquire(lockDir);
  try {
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
  if (process.env.CURSOR_PLUGIN_ROOT) return 'cursor';
  if (process.env.GEMINI_CLI_ROOT) return 'gemini-cli';
  if (process.env.CLINE_PLUGIN_ROOT) return 'cline';
  if (process.env.CLAUDE_PLUGIN_ROOT && process.env.CLAUDE_PLUGIN_ROOT.includes('claude')) return 'claude-code';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  return '(other)';
}
