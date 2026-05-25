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

// Contract with the hook reader (scripts/hooks/common.mjs) + MCP status probe:
// `enabled:` must be the FIRST (indented) child line of a COLUMN-0 top-level
// `capture:` key. Anchoring to `^capture:` (no leading whitespace, + /m) scopes
// the probe to the real global key: it excludes a sibling like `other_capture:`
// (R4 N4) AND an indented/nested `capture:` under another mapping (R5 N6).
// readCurrentEnabled uses the identical regex so the toggle and the hook never
// disagree. applyToggle guarantees canonical (enabled-first, column-0) output,
// so a non-canonical hand-edited config is repaired on the next real transition.
const ENABLED_RE = /^capture:[ \t]*\r?\n[ \t]+enabled:[ \t]*true\b/m;

function readCurrentEnabled(text) {
  return ENABLED_RE.test(text);
}

// Serialize the read-compare-write-audit critical section with a mkdir-atomic
// lock (kept synchronous so the public API stays sync — capture toggles are
// rare CLI ops). Without it, two concurrent toggles of this GLOBAL privacy
// setting could interleave into a lost update / out-of-order audit history.
const LOCK_STALE_MS = 30000;
const LOCK_DEADLINE_MS = 10000;
const LOCK_SPIN_MS = 25;

function syncSleep(ms) {
  // Block this thread without busy-spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withConfigLock(root, fn) {
  const lockDir = path.join(root, '.capture.lock');
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Break a stale lock left by a crashed process.
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* lock vanished between stat and rmdir — retry */ }
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire capture config lock at ${lockDir} within ${LOCK_DEADLINE_MS}ms`);
      }
      syncSleep(LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* best-effort release */ }
  }
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

  // Locate the COLUMN-0 (top-level) capture: line only — an indented/nested
  // `capture:` under another mapping is a different key and must not be edited
  // as the global toggle (R5 N6). parentIndent is therefore always empty.
  const parentIndent = '';
  let capIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^capture:[ \t]*(?:#.*)?$/.test(lines[i])) { capIdx = i; break; }
  }

  if (capIdx === -1) {
    const block = ['capture:', '  enabled: ' + value, '  eager_distill: false'];
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

  // Keep every existing child line except the DIRECT-child `enabled:` (which we
  // re-emit first). Only strip an `enabled:` at the direct-child indent depth —
  // a deeper-nested `enabled:` (e.g. a per-filter flag under capture.filters)
  // belongs to another mapping and must be preserved (no data loss).
  const childBody = [];
  for (let i = capIdx + 1; i < end; i++) {
    const lineIndent = lines[i].match(/^[ \t]*/)[0];
    if (lineIndent.length <= childIndent.length && /^[ \t]*enabled:\s*(?:true|false)\b/.test(lines[i])) {
      continue;
    }
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
  const to = Boolean(target);

  fs.mkdirSync(root, { recursive: true }); // lock dir needs root to exist

  // The whole read → compare → write → audit sequence runs under one lock so a
  // concurrent toggle of this global setting cannot interleave (lost update) or
  // produce an audit history out of order with the config state.
  return withConfigLock(root, () => {
    let text;
    if (fs.existsSync(configPath)) {
      text = fs.readFileSync(configPath, 'utf8');
    } else {
      text = defaultConfigYaml();
      writeTextAtomic(configPath, text);
    }

    const from = readCurrentEnabled(text);
    // Semantic no-op: only a real state transition writes or audits. (A config
    // that is non-canonical but reads the same is left untouched — repairing it
    // would emit a misleading {from:X,to:X} transition audit.)
    if (from === to) {
      return { from, to, changed: false };
    }

    const newText = applyToggle(text, to);
    const entry = { kind: 'capture-toggle', by, host, payload: { from, to, method } };

    if (to === true) {
      // ENABLE is privacy-increasing: persist the audit entry FIRST, then
      // publish capture.enabled:true. capture is therefore never ON without a
      // durable audit record — if writeEntry throws the config is left
      // untouched (fail closed → caller exits non-zero), and a crash between the
      // audit append and the config publish leaves capture OFF (privacy-safe).
      writeEntry(root, entry);
      writeTextAtomic(configPath, newText);
      return { from, to, changed: true };
    }

    // DISABLE is privacy-safe: publish the disabled config first; a missing
    // audit entry is non-fatal (spec §3.6) and surfaced as a warning.
    writeTextAtomic(configPath, newText);
    const result = { from, to, changed: true };
    try {
      writeEntry(root, entry);
    } catch (e) {
      result.warnings = [
        `capture.enabled was set to false but the capture-toggle audit-log entry failed: ${e.message}`,
      ];
    }
    return result;
  });
}

/**
 * Create config.yaml with the default template if absent — UNDER the same lock
 * as setCaptureEnabled, re-checking existence inside the critical section. This
 * lets a plain `/deep-memory-init` (no capture flag) materialize the config
 * without racing a concurrent `--enable-capture`: the locked re-check means the
 * default (disabled) config can never overwrite a config another process just
 * created/enabled (deep-review R6 N9).
 * @param {string} root - $DEEP_MEMORY_ROOT
 */
function ensureConfig(root) {
  const configPath = path.join(root, 'config.yaml');
  fs.mkdirSync(root, { recursive: true });
  withConfigLock(root, () => {
    if (!fs.existsSync(configPath)) writeTextAtomic(configPath, defaultConfigYaml());
  });
}

module.exports = { setCaptureEnabled, ensureConfig };
