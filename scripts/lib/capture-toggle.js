'use strict';
// scripts/lib/capture-toggle.js
// Flip config.yaml#capture.enabled and record the transition. Targeted text
// edit (not YAML parse/serialize) so the written shape stays byte-compatible
// with the hook reader's regex contract (scripts/hooks/common.mjs) and user
// comments/formatting are preserved. Spec: 2026-05-25-capture-toggle-design.md.

const fs = require('node:fs');
const path = require('node:path');
const { writeTextAtomic } = require('./atomic-write');
const { writeEntry } = require('./audit-log');
const { defaultConfigYaml } = require('./default-config');

// Contract with the hook reader (scripts/hooks/common.mjs):
// /capture:\s*\n\s*enabled:\s*true/ — `enabled:` must be the FIRST child line
// of `capture:`. readCurrentEnabled uses the identical regex so the toggle and
// the hook never disagree about the current state. applyToggle guarantees its
// output is canonical (enabled first), so a non-canonical hand-edited config is
// repaired on the next real transition.
const ENABLED_RE = /capture:\s*\n\s*enabled:\s*true/;

function readCurrentEnabled(text) {
  return ENABLED_RE.test(text);
}

// Rebuild the `capture:` block so `enabled: <value>` is its first child line,
// preserving the `capture:` line (incl. any trailing comment), all other child
// keys (e.g. eager_distill), the file's indentation, and its EOL style. The
// edit is scoped strictly to the block — it never touches an `enabled:` key
// that belongs to a later section (sources, etc.). If no `capture:` block
// exists, a canonical one is appended.
function applyToggle(text, target) {
  const value = target ? 'true' : 'false';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNl = /\r?\n$/.test(text);

  const lines = text.split(/\r?\n/);
  if (hadTrailingNl) lines.pop(); // drop the empty element from the trailing newline

  // Locate the capture: line (any indentation, optional trailing comment).
  let capIdx = -1;
  let parentIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(/^([ \t]*)capture:[ \t]*(?:#.*)?$/);
    if (mm) { capIdx = i; parentIndent = mm[1]; break; }
  }

  if (capIdx === -1) {
    const block = [`${parentIndent}capture:`, '  enabled: ' + value, '  eager_distill: false'];
    return lines.concat(block).join(nl) + nl;
  }

  // Block ends at the first non-blank, non-comment line indented <= parent.
  let end = capIdx + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t === '' || t.startsWith('#')) { end++; continue; }
    const indent = lines[end].match(/^[ \t]*/)[0];
    if (indent.length <= parentIndent.length) break;
    end++;
  }

  // Match the re-emitted `enabled:` line to the block's existing child indent
  // (tabs or spaces) so we never mix indentation styles under one mapping;
  // fall back to two spaces when the block has no other child.
  const existingChild = lines
    .slice(capIdx + 1, end)
    .find((l) => l.trim() && !l.trim().startsWith('#'));
  const childIndent = existingChild ? existingChild.match(/^[ \t]*/)[0] : parentIndent + '  ';

  // Keep every existing child line except any `enabled:` (re-emitted first).
  const childBody = [];
  for (let i = capIdx + 1; i < end; i++) {
    if (/^[ \t]*enabled:\s*(?:true|false)\b/.test(lines[i])) continue;
    childBody.push(lines[i]);
  }

  // Normalize the `capture:` line to bare `capture:` (drop any inline comment
  // on the key line). The hook reader requires `enabled:` to immediately follow
  // `capture:` with only whitespace between, so an inline comment on the key
  // line is fundamentally unreadable — normalizing it is the only reader-safe
  // layout. Child-line comments below are preserved in childBody.
  const rebuilt = [`${parentIndent}capture:`, `${childIndent}enabled: ${value}`, ...childBody];
  const out = [...lines.slice(0, capIdx), ...rebuilt, ...lines.slice(end)];
  return out.join(nl) + (hadTrailingNl ? nl : '');
}

/**
 * Set config.yaml#capture.enabled, emitting a `capture-toggle` audit-log entry
 * only on an actual transition (idempotent on a no-op).
 *
 * @param {string} root - $DEEP_MEMORY_ROOT (config.yaml lives directly under it)
 * @param {boolean} target - desired capture.enabled state
 * @param {object} opts - { by='cli-flag', method='cli-flag', host }
 * @returns {{from: boolean, to: boolean, changed: boolean, warnings?: string[]}}
 */
function setCaptureEnabled(root, target, opts = {}) {
  const { by = 'cli-flag', method = 'cli-flag', host } = opts;
  const configPath = path.join(root, 'config.yaml');

  let text;
  if (fs.existsSync(configPath)) {
    text = fs.readFileSync(configPath, 'utf8');
  } else {
    text = defaultConfigYaml();
    fs.mkdirSync(root, { recursive: true });
    writeTextAtomic(configPath, text);
  }

  const from = readCurrentEnabled(text);
  const to = Boolean(target);
  // Semantic no-op: only a real state transition writes or audits. (A config
  // that is non-canonical but reads the same is left untouched — repairing it
  // would emit a misleading {from:X,to:X} transition audit.)
  if (from === to) {
    return { from, to, changed: false };
  }

  // Config is the source of truth — write it first. The audit-log is a
  // secondary trail: per spec §3.6 an audit-write failure must NOT crash init
  // or abort the (already-applied) transition, so it is surfaced as a warning.
  writeTextAtomic(configPath, applyToggle(text, to));
  const result = { from, to, changed: true };
  try {
    writeEntry(root, { kind: 'capture-toggle', by, host, payload: { from, to, method } });
  } catch (e) {
    result.warnings = [
      `capture.enabled was set to ${to} but the capture-toggle audit-log entry failed: ${e.message}`,
    ];
  }
  return result;
}

module.exports = { setCaptureEnabled };
