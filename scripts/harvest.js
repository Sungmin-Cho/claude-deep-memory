// scripts/harvest.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { wrap } = require('./lib/envelope');
const { redactObject } = require('./lib/redact');
const { dedupeKey } = require('./lib/dedupe');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { hashFile } = require('./lib/source-hash');
const { acquire, release } = require('./lib/lock');

const REVIEW_AFTER_DAYS = 90;
const LEASE_STALE_MS = 30 * 60 * 1000; // 30 min — spec §"Phase 2 Task 2.5"

// Phase 4 Task 4.2 introduces ./lib/fts-index — Phase 2 dynamic-requires it so the
// FTS5 upsert path is a no-op until that module lands, without breaking persist.
let fts = null;
try { fts = require('./lib/fts-index'); } catch { /* Phase 4 wires this */ }

/**
 * spec §7.1 — Step A mapper for `.deep-review/recurring-findings.json`.
 *   claim source: finding.title (deterministic, F1 — never empty)
 *   evidence_summary: first 5 evidence strings
 *   applicability: [{value: category, source_id, confidence: 0.7}]
 *   tags: finding.tags
 *   created_at: finding.first_seen
 */
function mapRecurringFindings(artifact, sourceMeta) {
  const findings = artifact.payload?.findings || [];
  return findings.map((f) => ({
    memory_type: 'failure-case',
    title: f.title,
    claim: f.title,
    evidence_summary: (f.evidence || []).slice(0, 5),
    applicability: f.category
      ? [{ value: f.category, source_id: sourceMeta.id, confidence: 0.7 }]
      : [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: f.tags || [],
    created_at: f.first_seen || new Date().toISOString(),
  }));
}

/**
 * spec §7.1 — Step A mapper for `.deep-evolve/*\/evolve-insights.json`.
 *   claim source: insight.strategy (deterministic, F1)
 *   evidence_summary: [insight.outcome] if present
 *   applicability: project_signature key=value pairs (confidence 0.7)
 *   confidence: insight.q_delta normalized to [0,1] — q_delta of 0.5+ saturates to 1.0
 *   tags: ['evolve', 'experiment']
 */
function mapEvolveInsights(artifact, sourceMeta) {
  const insights = artifact.payload?.insights || [];
  return insights.map((i) => ({
    memory_type: 'experiment-outcome',
    title: i.strategy,
    claim: i.strategy,
    evidence_summary: [i.outcome].filter(Boolean).slice(0, 5),
    applicability: Object.entries(i.project_signature || {}).map(([k, v]) => ({
      value: `${k}=${v}`,
      source_id: sourceMeta.id,
      confidence: 0.7,
    })),
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: ['evolve', 'experiment'],
    confidence: Math.max(0, Math.min(1, (i.q_delta || 0) / 0.5)),
    created_at: new Date().toISOString(),
  }));
}

/**
 * spec §7.1 — Step A mapper for `.deep-work/*\/session-receipt.json`.
 *   Branches by slice.outcome:
 *     success → memory_type=pattern,    claim = "Pattern: <title> — <outcome_summary>"
 *     failure → memory_type=failure-case, claim = "Failure: <title> — <failure_reason>"
 *   Other outcomes (e.g. "skipped") are ignored — no card produced.
 *   evidence_summary: [slice.id] (deterministic single-element source)
 */
function mapWorkReceipt(artifact, sourceMeta) {
  const slices = artifact.payload?.slices || [];
  const out = [];
  for (const s of slices) {
    if (s.outcome === 'success') {
      out.push({
        memory_type: 'pattern',
        title: s.title,
        claim: `Pattern: ${s.title} — ${s.outcome_summary || 'success'}`,
        evidence_summary: [s.id],
        applicability: [],
        non_applicability: [],
        recommended_action: [],
        search_keywords: [],
        tags: ['deep-work', 'pattern'],
        confidence: 0.5,
        created_at: new Date().toISOString(),
      });
    } else if (s.outcome === 'failure') {
      out.push({
        memory_type: 'failure-case',
        title: s.title,
        claim: `Failure: ${s.title} — ${s.failure_reason || 'unspecified'}`,
        evidence_summary: [s.id],
        applicability: [],
        non_applicability: [],
        recommended_action: [],
        search_keywords: [],
        tags: ['deep-work', 'failure-case'],
        confidence: 0.5,
        created_at: new Date().toISOString(),
      });
    }
  }
  return out;
}

/**
 * spec §7.1 — Step A mapper for `.deep-docs/last-scan.json`.
 *   claim source: "<drift.title> — <drift.recommended_fix>" (deterministic, F1)
 *   evidence_summary: [drift.path] if present
 *   applicability: language=<drift.language> if present
 *   recommended_action: [drift.recommended_fix] if present
 */
function mapDocsScan(artifact, sourceMeta) {
  const drifts = artifact.payload?.drifts || [];
  return drifts.map((d) => ({
    memory_type: 'coding-style',
    title: d.title,
    claim: `${d.title} — ${d.recommended_fix || 'no recommendation'}`,
    evidence_summary: [d.path].filter(Boolean).slice(0, 5),
    applicability: d.language
      ? [{ value: `language=${d.language}`, source_id: sourceMeta.id, confidence: 0.6 }]
      : [],
    non_applicability: [],
    recommended_action: d.recommended_fix ? [d.recommended_fix] : [],
    search_keywords: [],
    tags: ['deep-docs', 'style'],
    confidence: 0.5,
    created_at: new Date().toISOString(),
  }));
}

/**
 * spec §7.1 — Step A mapper for `<wiki_root>/.wiki-meta/index.json`.
 *   Filters pages by frontmatter.adr === true (ADR-tagged pages only).
 *   claim source: page.frontmatter.decision_summary || page.title || page.path (F1)
 *   evidence_summary: [page.path] (single deterministic source)
 *   tags: ['wiki', 'adr']
 *   confidence: 0.7 (ADR pages are typically validated decisions)
 */
function mapWikiIndex(artifact, sourceMeta) {
  const pages = artifact.payload?.pages || [];
  return pages
    .filter((p) => p.frontmatter?.adr === true)
    .map((p) => ({
      memory_type: 'architecture-decision',
      title: p.title || p.path,
      claim: p.frontmatter?.decision_summary || p.title || p.path,
      evidence_summary: [p.path].filter(Boolean).slice(0, 5),
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: [],
      tags: ['wiki', 'adr'],
      confidence: 0.7,
      created_at: new Date().toISOString(),
    }));
}

/**
 * Phase 3a.5 — all 5 spec §7.1 Step A mappers wired.
 *
 *   source kind         → memory_type
 *   ─────────────────────────────────────────
 *   review-recurring    → failure-case
 *   evolve-insights     → experiment-outcome
 *   work-receipt        → pattern | failure-case (branched by slice.outcome)
 *   docs-scan           → coding-style
 *   wiki-index          → architecture-decision (ADR filter)
 *
 * Registry key MUST match `config.yaml#sources[*].kind`. Tests assert the exact set.
 */
const STEP_A_MAPPERS = {
  'review-recurring': mapRecurringFindings,
  'evolve-insights': mapEvolveInsights,
  'work-receipt': mapWorkReceipt,
  'docs-scan': mapDocsScan,
  'wiki-index': mapWikiIndex,
};

function memoryIdFor(memoryType, dk) {
  const typeSlug = memoryType.replace(/-/g, '_');
  const shortHash = createHash('sha256').update(dk).digest('hex').slice(0, 6);
  return 'mem_' + typeSlug + '_' + shortHash;
}

function buildSourceMeta(artifactPath, raw, sourceKind) {
  return {
    id: 'src_0',
    path: artifactPath,
    content_hash: hashFile(artifactPath),
    captured_at: new Date().toISOString(),
    artifact_kind: raw.envelope?.artifact_kind || sourceKind,
    schema_version: raw.envelope?.schema?.version || '1.0',
    run_id: raw.envelope?.run_id || 'unknown',
  };
}

function buildCardFromDraft(draft, sourceMeta) {
  const dk = dedupeKey(draft.memory_type, draft.claim, draft.applicability);
  const id = memoryIdFor(draft.memory_type, dk);
  const now = Date.now();
  const payload = {
    ...draft,
    memory_id: id,
    dedupe_key: dk,
    privacy_level: 'local',
    status: 'candidate',
    status_history: [],
    last_seen_at: new Date(now).toISOString(),
    review_after: new Date(now + REVIEW_AFTER_DAYS * 86400 * 1000).toISOString(),
    feedback: { accepted_count: 0, rejected_count: 0, inaccurate_count: 0 },
    confidence: typeof draft.confidence === 'number' ? draft.confidence : 0.5,
  };
  return wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload,
    provenance: { source_artifacts: [sourceMeta] },
  });
}

/**
 * Phase 2 entry point. Reads one artifact, runs Step A mapping (1 mapper active —
 * `review-recurring`; Phase 3a expands to all 5), applies Pass 1 redaction, filters
 * F1-violating drafts (empty claim/title/evidence), wraps each draft in an envelope,
 * and persists cards under `cards/<memory_type>/<project_id>/`.
 *
 * Step B (LLM refinement) is intentionally skipped here — wired in Phase 3b.
 * Persist is "simplified" (no lock/lease/event JSONL/FTS5) — Task 2.5 retrofits.
 */
async function harvestArtifact({
  artifactPath,
  sourceKind,
  memoryRoot,
  projectId,
  skipDistillStepB = false, // eslint-disable-line no-unused-vars
}) {
  const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const sourceMeta = buildSourceMeta(artifactPath, raw, sourceKind);
  const mapper = STEP_A_MAPPERS[sourceKind];
  if (!mapper) throw new Error(`Unknown sourceKind: ${sourceKind}`);

  // Pass 1 redaction — applied to raw artifact before Step A reads it
  const redacted = redactObject(raw);
  let drafts = mapper(redacted, sourceMeta);

  // F1 invariant — claim/title/evidence_summary all required.
  // (Phase 3a will route filtered drafts to `~/.deep-memory/.quarantine/empty-claim/<run_id>.json`.)
  drafts = drafts.filter(
    (d) => d.claim && d.title && Array.isArray(d.evidence_summary) && d.evidence_summary.length > 0
  );

  // Step B (LLM refinement) wired in Phase 3b — for now, Step A drafts go straight to envelope wrap.
  // When skipDistillStepB === false in Phase 3b, llm-bridge.refine(draft, source) will be called here.

  const cards = drafts.map((d) => buildCardFromDraft(d, sourceMeta));

  await persistWithLockAndLease({ memoryRoot, projectId, cards, sourceMeta });
  return cards;
}

/**
 * Idempotency key for the events JSONL — pinning the (source path, content hash, run_id)
 * triple ensures a re-harvest of the same artifact produces zero new event lines.
 * Concurrent harvests against the same project are additionally fenced by the lease.
 */
function eventKey(sourceMeta) {
  const tuple = [sourceMeta.path, sourceMeta.content_hash, sourceMeta.run_id].join('|');
  return createHash('sha256').update(tuple).digest('hex');
}

function readLeaseSafe(leasePath) {
  try { return JSON.parse(fs.readFileSync(leasePath, 'utf8')); }
  catch { return null; }
}

/**
 * spec §7.3 — wraps card / events / FTS5 writes in one critical section:
 *   1. acquire project lease (`<memory_root>/.leases/<project_id>.lease`) — 30min stale-break
 *   2. acquire global lock (`<memory_root>/.lock`) — mkdir-atomic, covers index commit too
 *   3. append idempotent event line to `events/YYYY-MM.jsonl` (skip if event_key seen)
 *   4. atomic write each card under `cards/<memory_type>/<project_id>/`
 *   5. FTS5 upsert in same lock window (Phase 4 wires the actual driver)
 *   6. release global lock, then delete lease (finally guard)
 */
async function persistWithLockAndLease({ memoryRoot, projectId, cards, sourceMeta }) {
  const leaseDir = path.join(memoryRoot, '.leases');
  fs.mkdirSync(leaseDir, { recursive: true });
  const leasePath = path.join(leaseDir, projectId + '.lease');

  // 1. lease — claim atomically via wx flag so concurrent callers see EEXIST
  const leasePayload = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    started_at: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(leasePath, leasePayload, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = readLeaseSafe(leasePath);
    if (existing && Date.now() - new Date(existing.started_at).getTime() < LEASE_STALE_MS) {
      throw new Error(
        `Another session already harvesting project ${projectId} ` +
        `(started ${existing.started_at}, pid ${existing.pid}). ` +
        `Try later or wait ~30min for stale-break.`
      );
    }
    // stale lease — overwrite
    fs.writeFileSync(leasePath, leasePayload);
  }

  const lockPath = path.join(memoryRoot, '.lock');
  const handle = await acquire(lockPath, { operation: 'harvest' });
  try {
    // 3. idempotent event append
    const yearMonth = new Date().toISOString().slice(0, 7);
    const eventsDir = path.join(memoryRoot, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const eventsFile = path.join(eventsDir, yearMonth + '.jsonl');
    const existing = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    const key = eventKey(sourceMeta);
    if (!existing.includes(`"event_key":"${key}"`)) {
      const event = {
        event_key: key,
        source: sourceMeta,
        run_id: sourceMeta.run_id,
        at: new Date().toISOString(),
        cards_count: cards.length,
        project_id: projectId,
      };
      fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
    }

    // 4. atomic card writes
    for (const c of cards) {
      const dir = path.join(memoryRoot, 'cards', c.payload.memory_type, projectId);
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, c.payload.memory_id + '.json'), c);
    }

    // 5. FTS5 upsert in same lock window (Phase 4 wires ./lib/fts-index)
    if (fts && fts.openIndex && fts.upsertCard) {
      const idx = fts.openIndex(path.join(memoryRoot, 'indexes', 'lexical.sqlite'));
      try {
        if (idx.driver === 'better-sqlite3') idx.db.exec('BEGIN');
        for (const c of cards) fts.upsertCard(idx, c, { projectId });
        if (idx.driver === 'better-sqlite3') idx.db.exec('COMMIT');
      } finally {
        if (idx.driver === 'better-sqlite3' && idx.db && typeof idx.db.close === 'function') {
          idx.db.close();
        }
      }
    }
  } finally {
    release(handle);
    try { fs.unlinkSync(leasePath); } catch { /* best-effort */ }
  }
}

module.exports = {
  harvestArtifact,
  mapRecurringFindings,
  mapEvolveInsights,
  mapWorkReceipt,
  mapDocsScan,
  mapWikiIndex,
  STEP_A_MAPPERS,
  buildCardFromDraft,
  buildSourceMeta,
  memoryIdFor,
  persistWithLockAndLease,
  eventKey,
  REVIEW_AFTER_DAYS,
  LEASE_STALE_MS,
};
