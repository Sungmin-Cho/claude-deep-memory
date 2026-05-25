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

// Same probe the hook reader uses — `enabled: true` anywhere inside the
// capture block means ON. Absence / `false` / no block means OFF.
const ENABLED_RE = /capture:\s*\n\s*enabled:\s*true/;

function readCurrentEnabled(text) {
  return ENABLED_RE.test(text);
}

// Replace the first `enabled:` line that follows the `capture:` marker. The
// default template has no other `enabled:` key, so anchoring on `capture:`
// keeps the edit confined to the capture block.
function applyToggle(text, target) {
  const captureIdx = text.search(/^capture:[ \t]*$/m);
  const value = target ? 'true' : 'false';
  if (captureIdx === -1) {
    // No capture block (legacy / hand-trimmed config) — append one.
    const sep = text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}capture:\n  enabled: ${value}\n  eager_distill: false\n`;
  }
  const before = text.slice(0, captureIdx);
  const rest = text.slice(captureIdx);
  const newRest = rest.replace(/enabled:\s*(?:true|false)/, `enabled: ${value}`);
  return before + newRest;
}

/**
 * Set config.yaml#capture.enabled, emitting a `capture-toggle` audit-log entry
 * only on an actual transition (idempotent on a no-op).
 *
 * @param {string} root - $DEEP_MEMORY_ROOT (config.yaml lives directly under it)
 * @param {boolean} target - desired capture.enabled state
 * @param {object} opts - { by='cli-flag', method='cli-flag', host }
 * @returns {{from: boolean, to: boolean, changed: boolean}}
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
  if (from === to) {
    return { from, to, changed: false };
  }

  writeTextAtomic(configPath, applyToggle(text, to));
  writeEntry(root, {
    kind: 'capture-toggle',
    by,
    host,
    payload: { from, to, method }
  });
  return { from, to, changed: true };
}

module.exports = { setCaptureEnabled };
