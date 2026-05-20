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
const { isStale: lockIsStale, breakLock } = require('./lib/lock');
const { hashFile } = require('./lib/source-hash');

const PROFILE_MAX_AGE_DAYS_DEFAULT = 30;

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

/**
 * Task 5.3 — detect stale global lock + (optionally) break it.
 *
 * Returns:
 *   {
 *     locks: [{path, meta, stale, age_ms}],   // every lock found
 *     broken: [<lockPath>],                    // only populated when {unlock: true}
 *   }
 *
 * Considers only the canonical global lock at `<memory_root>/.lock`. Project
 * leases (`.leases/<project_id>.lease`) are tracked separately by the harvest
 * pipeline — Phase 5 expands that to a lease audit only if Phase 5.x demands
 * it (current MVP: harvest's own finally guard removes stale lease at next run).
 */
function detectStaleLocks(memoryRoot, { unlock = false } = {}) {
  const lockPath = path.join(memoryRoot, '.lock');
  const out = { locks: [], broken: [] };
  if (!fs.existsSync(lockPath)) return out;
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
  } catch {
    // malformed lock dir — surface as stale (no recoverable metadata)
    meta = { created_at: new Date(0).toISOString(), pid: null, host: null, operation: 'unknown' };
  }
  const age_ms = Date.now() - new Date(meta.created_at).getTime();
  const stale = lockIsStale(meta);
  out.locks.push({ path: lockPath, meta, stale, age_ms });
  if (stale && unlock) {
    breakLock(lockPath);
    out.broken.push(lockPath);
  }
  return out;
}

/**
 * Task 5.4 — detect dedupe collisions (spec §6.4).
 *
 * Two cards share the same dedupe_key but have CONTRADICTING applicability sets
 * (different source_id values or disjoint value sets). The dedupe_key is meant
 * to collapse equivalent claims; when two cards collide on the key but disagree
 * on context, the audit flags them so the user can either:
 *   (a) merge applicability arrays (intentional re-context), or
 *   (b) deprecate one of the two (conflicting claim should not co-exist).
 *
 * Returns:
 *   {
 *     scanned: <int>,
 *     collisions: [{
 *       dedupe_key,
 *       memory_ids: [<id>],
 *       paths: [<path>],
 *       contradiction_kind: 'applicability_contradiction' | 'duplicate',
 *     }],
 *   }
 */
function detectDedupeCollisions(memoryRoot) {
  const cardsRoot = path.join(memoryRoot, 'cards');
  const buckets = new Map(); // dedupe_key → [{card, path, memory_id}]
  let scanned = 0;
  for (const entry of allCardFiles(cardsRoot)) {
    scanned += 1;
    let card;
    try { card = JSON.parse(fs.readFileSync(entry.path, 'utf8')); }
    catch { continue; }
    const dk = card.payload?.dedupe_key;
    if (!dk) continue;
    if (!buckets.has(dk)) buckets.set(dk, []);
    buckets.get(dk).push({
      card,
      path: entry.path,
      memory_id: card.payload?.memory_id || null,
      applicability: card.payload?.applicability || [],
    });
  }

  const collisions = [];
  for (const [dk, entries] of buckets) {
    if (entries.length < 2) continue;
    // Apply spec §6.4 contradiction policy: cards collide when applicability
    // value-sets differ. If the value-sets are identical, the cards are a true
    // duplicate (different memory_ids for same claim+context) — also reported
    // for downstream dedupe merge.
    const sets = entries.map((e) => new Set(
      e.applicability.map((a) => (typeof a === 'string' ? a : a.value)).filter(Boolean)
    ));
    const allSame = sets.every((s, i) => i === 0 || setsEqual(sets[0], s));
    const kind = allSame ? 'duplicate' : 'applicability_contradiction';
    collisions.push({
      dedupe_key: dk,
      memory_ids: entries.map((e) => e.memory_id),
      paths: entries.map((e) => e.path),
      contradiction_kind: kind,
    });
  }
  return { scanned, collisions };
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Task 5.5 — detect source-artifact renames / content drift.
 *
 * For every card, walk payload.deep_memory_provenance[] and compare each entry's
 * `content_hash` (captured at harvest time) against `hashFile()` of the live
 * source artifact at envelope.provenance.source_artifacts[source_index].path.
 *
 * Mismatch cases:
 *   - file missing entirely  → unresolved_source.reason = 'missing'
 *   - hash drift             → unresolved_source.reason = 'content_drift'
 *   - source_index out of range → unresolved_source.reason = 'index_oob'
 *
 * Returns:
 *   {
 *     scanned: <int>,                    // total cards scanned
 *     unresolved: [{
 *       path: <cardPath>,
 *       memory_id, reason, dp_id,
 *       expected_hash, actual_hash, source_path
 *     }],
 *   }
 */
function detectSourceRenames(memoryRoot) {
  const cardsRoot = path.join(memoryRoot, 'cards');
  const out = { scanned: 0, unresolved: [] };
  for (const entry of allCardFiles(cardsRoot)) {
    out.scanned += 1;
    let card;
    try { card = JSON.parse(fs.readFileSync(entry.path, 'utf8')); }
    catch { continue; }
    const sa = card.envelope?.provenance?.source_artifacts || [];
    const dp = card.payload?.deep_memory_provenance || [];
    for (const d of dp) {
      const idx = d.source_index;
      if (typeof idx !== 'number' || idx < 0 || idx >= sa.length) {
        out.unresolved.push({
          path: entry.path,
          memory_id: card.payload?.memory_id || null,
          reason: 'index_oob',
          dp_id: d.id,
          expected_hash: d.content_hash,
          actual_hash: null,
          source_path: null,
        });
        continue;
      }
      const srcPath = sa[idx].path;
      if (!fs.existsSync(srcPath)) {
        out.unresolved.push({
          path: entry.path,
          memory_id: card.payload?.memory_id || null,
          reason: 'missing',
          dp_id: d.id,
          expected_hash: d.content_hash,
          actual_hash: null,
          source_path: srcPath,
        });
        continue;
      }
      let actual;
      try { actual = hashFile(srcPath); }
      catch { actual = null; }
      if (actual !== d.content_hash) {
        out.unresolved.push({
          path: entry.path,
          memory_id: card.payload?.memory_id || null,
          reason: 'content_drift',
          dp_id: d.id,
          expected_hash: d.content_hash,
          actual_hash: actual,
          source_path: srcPath,
        });
      }
    }
  }
  return out;
}

/**
 * Task 5.6 — detect stale project-profile.json (older than profile_max_age_days).
 * Reads `.deep-memory/project-profile.json` from the supplied projectDir (defaults
 * to cwd) and compares `generated_at` to today.
 *
 * Returns:
 *   { exists: bool, age_days: number|null, stale: bool, max_age_days, profile_path }
 */
function detectStaleProfile(projectDir, { maxAgeDays = PROFILE_MAX_AGE_DAYS_DEFAULT } = {}) {
  const profilePath = path.join(projectDir, '.deep-memory', 'project-profile.json');
  if (!fs.existsSync(profilePath)) {
    return {
      exists: false,
      age_days: null,
      stale: false,
      max_age_days: maxAgeDays,
      profile_path: profilePath,
    };
  }
  let profile;
  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); }
  catch {
    return {
      exists: true,
      age_days: null,
      stale: true,
      max_age_days: maxAgeDays,
      profile_path: profilePath,
      parse_error: true,
    };
  }
  const generatedAt = profile.generated_at ? new Date(profile.generated_at) : null;
  if (!generatedAt || isNaN(generatedAt.getTime())) {
    return {
      exists: true,
      age_days: null,
      stale: true,
      max_age_days: maxAgeDays,
      profile_path: profilePath,
    };
  }
  const age_days = (Date.now() - generatedAt.getTime()) / (86400 * 1000);
  return {
    exists: true,
    age_days,
    stale: age_days > maxAgeDays,
    max_age_days: maxAgeDays,
    profile_path: profilePath,
  };
}

module.exports = {
  validateAllCards,
  applyAutoTransitions,
  detectStaleLocks,
  detectDedupeCollisions,
  detectSourceRenames,
  detectStaleProfile,
  allCardFiles,
  validateCardSchema,
  PROFILE_MAX_AGE_DAYS_DEFAULT,
};
