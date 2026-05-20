// scripts/audit.js
//
// Audit pipeline for the deep-memory store. Each sub-feature is a pure function
// that returns a result object; the top-level `run()` orchestrator (Task 5.8)
// aggregates them into `.deep-memory/latest-audit.json`.
//
// Sub-features (per plan §"Phase 5"):
//   Task 5.1  validateAllCards()       — Ajv strict on memory-card.schema.json
//   Task 5.2  applyAutoTransitions()   — state-machine.evaluateTransitions + atomic write
//   Task 5.3  detectStaleLocks() + unlock()
//   Task 5.4  detectDedupeCollisions() — same dedupe_key with contradicting applicability
//   Task 5.5  detectSourceRenames()    — content_hash drift on source artifacts
//   Task 5.6  detectStaleProfile()     — project-profile.json older than audit.profile_max_age_days
//   Task 5.7  promoteCard()            — atomic local → global with lock protection
//   Task 5.8  run() + CLI entry
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats').default || require('ajv-formats');

const { evaluateTransitions } = require('./lib/state-machine');
const { writeJsonAtomic } = require('./lib/atomic-write');

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const cardSchemaPath = path.join(__dirname, '../schemas/memory-card.schema.json');
const cardSchema = JSON.parse(fs.readFileSync(cardSchemaPath, 'utf8'));
const validateCardSchema = ajv.compile(cardSchema);

function* allCardFiles(cardsRoot) {
  if (!fs.existsSync(cardsRoot)) return;
  for (const type of fs.readdirSync(cardsRoot)) {
    const td = path.join(cardsRoot, type);
    if (!fs.statSync(td).isDirectory()) continue;
    for (const scope of fs.readdirSync(td)) {
      const sd = path.join(td, scope);
      if (!fs.statSync(sd).isDirectory()) continue;
      for (const f of fs.readdirSync(sd)) {
        if (f.endsWith('.json')) yield { path: path.join(sd, f), type, scope, file: f };
      }
    }
  }
}

/**
 * Task 5.1 — scan every card under <memory_root>/cards/ and validate against
 * memory-card.schema.json (Ajv strict + addFormats). Returns:
 *   {
 *     total: <int>,
 *     valid: <int>,
 *     invalid: <int>,
 *     schema_violations: [{ path, memory_id, errors: [{instancePath, message, params}] }],
 *   }
 *
 * Cards that fail JSON.parse are also reported as violations (with `parse_error`
 * marker). The check never throws — partial-failure audit is the whole point.
 */
function validateAllCards(memoryRoot) {
  const cardsRoot = path.join(memoryRoot, 'cards');
  const result = {
    total: 0,
    valid: 0,
    invalid: 0,
    schema_violations: [],
  };
  for (const entry of allCardFiles(cardsRoot)) {
    result.total += 1;
    let card;
    try {
      card = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
    } catch (e) {
      result.invalid += 1;
      result.schema_violations.push({
        path: entry.path,
        memory_id: null,
        parse_error: e.message,
      });
      continue;
    }
    const ok = validateCardSchema(card);
    if (ok) {
      result.valid += 1;
    } else {
      result.invalid += 1;
      result.schema_violations.push({
        path: entry.path,
        memory_id: card.payload?.memory_id || null,
        errors: (validateCardSchema.errors || []).map((e) => ({
          instancePath: e.instancePath,
          message: e.message,
          params: e.params,
        })),
      });
    }
  }
  return result;
}

/**
 * Task 5.2 — apply state-machine auto transitions to every card on disk.
 * Returns:
 *   {
 *     total: <int>,
 *     transitioned: <int>,
 *     transitions: [{memory_id, from, to, by, path}],
 *   }
 *
 * A transition mutates the card in-place via writeJsonAtomic and appends a
 * status_history entry. The status_history list is capped at MAX_HISTORY by
 * the state-machine (sliding window). This is the runtime invariant for
 * "stale memory" (validated → deprecated after review_after past) and the
 * 4 other automatic transitions defined in scripts/lib/state-machine.js.
 */
function applyAutoTransitions(memoryRoot) {
  const cardsRoot = path.join(memoryRoot, 'cards');
  const out = { total: 0, transitioned: 0, transitions: [] };
  for (const entry of allCardFiles(cardsRoot)) {
    out.total += 1;
    let card;
    try {
      card = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
    } catch {
      continue; // schema validation surfaces this separately
    }
    // The state-machine lib expects a flat view with status at top level;
    // we project the wrapped shape into that view (audit-only, no mutation).
    const view = {
      status: card.payload?.status,
      contradicting: card.contradicting || 0,
      supporting: card.supporting || 0,
      payload: card.payload,
    };
    const result = evaluateTransitions(view, { trimHistory: true });
    if (!result.transitioned) continue;

    const now = new Date().toISOString();
    card.payload.status = result.next;
    card.payload.status_history = [
      ...(result.trimmed || []),
      { from: result.current, to: result.next, at: now, by: result.by },
    ];
    if (card.payload.status_history.length > 10) {
      card.payload.status_history = card.payload.status_history.slice(-10);
    }
    writeJsonAtomic(entry.path, card);
    out.transitioned += 1;
    out.transitions.push({
      memory_id: card.payload?.memory_id || null,
      from: result.current,
      to: result.next,
      by: result.by,
      path: entry.path,
    });
  }
  return out;
}

module.exports = {
  validateAllCards,
  applyAutoTransitions,
  allCardFiles,
  validateCardSchema,
};
