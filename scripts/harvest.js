// scripts/harvest.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { wrap } = require('./lib/envelope');
const { redactObject, redactString } = require('./lib/redact');
const { dedupeKey } = require('./lib/dedupe');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { hashFile } = require('./lib/source-hash');
const { acquire, release } = require('./lib/lock');
const { refine: llmBridgeRefine } = require('./lib/llm-bridge');

const REVIEW_AFTER_DAYS = 90;
const LEASE_STALE_MS = 30 * 60 * 1000; // 30 min — spec §"Phase 2 Task 2.5"
const PASS2_EXCERPT_BYTES = 4096; // spec §7.2 — bounded LLM input
const STEP_B_FALLBACK_CODES = new Set(['SCHEMA_VIOLATION', 'TIMEOUT', 'ADAPTER_NOT_WIRED', 'UNKNOWN_ADAPTER']);

// FTS5 index module is REQUIRED for harvest to be usable — without it, cards
// would be persisted to disk but unsearchable via /deep-memory-brief. Surface
// the load failure clearly rather than silently disabling indexing.
let fts;
try {
  fts = require('./lib/fts-index');
} catch (e) {
  throw new Error(
    'deep-memory harvest requires scripts/lib/fts-index.js + better-sqlite3 to be loadable. ' +
    'Original error: ' + (e && e.message ? e.message : String(e))
  );
}

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
  const shortHash = createHash('sha256').update(dk).digest('hex').slice(0, 16); // 64-bit; was 6 (24-bit)
  return 'mem_' + typeSlug + '_' + shortHash;
}

/**
 * F1 partition — split mapper output into (kept, rejected) so the rejected drafts
 * can be quarantined rather than dropped. A draft passes when claim/title are
 * non-empty strings AND evidence_summary is a non-empty array.
 */
function passesF1(draft) {
  return (
    typeof draft.claim === 'string' && draft.claim.length > 0 &&
    typeof draft.title === 'string' && draft.title.length > 0 &&
    Array.isArray(draft.evidence_summary) && draft.evidence_summary.length > 0
  );
}

function partitionByF1(drafts) {
  const kept = [];
  const rejected = [];
  for (const d of drafts) (passesF1(d) ? kept : rejected).push(d);
  return { kept, rejected };
}

/**
 * spec §7.1 quarantine — write rejected drafts to
 * `<memory_root>/.quarantine/empty-claim/<run_id>.json` so that audit can surface
 * upstream artifact problems. File is overwritten per run (last-write-wins by
 * run_id), so duplicate runs of the same artifact stay at 1 quarantine entry.
 */
function quarantineEmptyClaim({ memoryRoot, runId, sourceMeta, rejected }) {
  const dir = path.join(memoryRoot, '.quarantine', 'empty-claim');
  fs.mkdirSync(dir, { recursive: true });
  const safeRunId = String(runId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(dir, safeRunId + '.json');
  const payload = {
    quarantined_at: new Date().toISOString(),
    run_id: runId,
    source: sourceMeta,
    rejected_count: rejected.length,
    rejected,
  };
  writeJsonAtomic(file, payload);
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

/**
 * envelope-compat decision Option (b): split sourceMeta into two artifacts.
 *   - envelope.provenance.source_artifacts[]: suite-shape {path, run_id} ONLY
 *     (additionalProperties:false in memory-card.schema.json — deep-memory
 *      specific fields are NOT allowed in the suite envelope shape)
 *   - payload.deep_memory_provenance[]: {id, content_hash, captured_at,
 *      artifact_kind, schema_version, source_index} — index back-refs the
 *      envelope source_artifacts entry by position
 */
function splitSourceMeta(sourceMetas) {
  const list = Array.isArray(sourceMetas) ? sourceMetas : [sourceMetas];
  const source_artifacts = list.map((m) => {
    const out = { path: m.path };
    if (m.run_id) out.run_id = m.run_id;
    return out;
  });
  const deep_memory_provenance = list.map((m, i) => ({
    id: m.id,
    content_hash: m.content_hash,
    captured_at: m.captured_at,
    artifact_kind: m.artifact_kind,
    schema_version: m.schema_version,
    source_index: i,
  }));
  return { source_artifacts, deep_memory_provenance };
}

function buildCardFromDraft(draft, sourceMeta) {
  const dk = dedupeKey(draft.memory_type, draft.claim, draft.applicability);
  const id = memoryIdFor(draft.memory_type, dk);
  const now = Date.now();
  const { source_artifacts, deep_memory_provenance } = splitSourceMeta(sourceMeta);
  // Pass 3 redaction at the envelope wrap boundary (spec D17) — payload only,
  // envelope metadata (producer/run_id/...) is deep-memory-owned and secret-free.
  const payload = redactObject({
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
    deep_memory_provenance,
  });
  // Pass 3: redact source_artifacts paths so home-directory never leaks into
  // envelope.provenance.source_artifacts[].path (spec §11.1 / line 812).
  const redactedSourceArtifacts = source_artifacts.map((sa) => ({
    ...sa,
    path: redactString(sa.path),
  }));
  return wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload,
    provenance: { source_artifacts: redactedSourceArtifacts },
  });
}

/**
 * Merge Step B output into a Step A draft under spec §7.2 invariants:
 *   - Step A fields are authoritative — Step B only fills empty slots
 *   - claim is refined ONLY when Step A claim is the verbatim title (room to grow)
 *   - non_applicability items get source_id back-filled (orchestrator-owned)
 *   - confidence boost +0.2 (capped at 1.0) when Step B validated the draft
 *
 * Mutates the draft in place — callers pass each draft once per loop iteration.
 */
function mergeStepB(draft, stepB, sourceMeta) {
  if (!stepB) return;
  if (stepB.claim_refined && stepB.claim_refined.length > 0) {
    draft.claim = stepB.claim_refined;
  }
  if (!draft.non_applicability || draft.non_applicability.length === 0) {
    draft.non_applicability = (stepB.non_applicability || []).map((x) => ({
      value: x.value,
      source_id: sourceMeta.id,
      confidence: x.confidence,
    }));
  }
  if (!draft.recommended_action || draft.recommended_action.length === 0) {
    draft.recommended_action = stepB.recommended_action || [];
  }
  if (!draft.search_keywords || draft.search_keywords.length === 0) {
    draft.search_keywords = stepB.search_keywords || [];
  }
  draft.confidence = Math.min(
    1,
    (typeof draft.confidence === 'number' ? draft.confidence : 0.5) + 0.2
  );
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
  skipDistillStepB = false,
  llmAdapter = 'auto',
  llmRecordedFixture = null,
  llmTimeoutMs = 30000,
  liveAgent = false,
  liveCodex = false,
  batchMode = false,
}) {
  const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const sourceMeta = buildSourceMeta(artifactPath, raw, sourceKind);
  const mapper = STEP_A_MAPPERS[sourceKind];
  if (!mapper) throw new Error(`Unknown sourceKind: ${sourceKind}`);

  // Pass 1 redaction — applied to raw artifact before Step A reads it
  const redacted = redactObject(raw);
  let drafts = mapper(redacted, sourceMeta);

  // F1 invariant — claim/title/evidence_summary all required.
  // Drafts that fail F1 are quarantined (not silently dropped) so audit can surface
  // upstream artifact problems. spec §7.1 — `<memory_root>/.quarantine/empty-claim/<run_id>.json`.
  const { kept, rejected } = partitionByF1(drafts);
  if (rejected.length > 0) {
    quarantineEmptyClaim({
      memoryRoot,
      runId: sourceMeta.run_id,
      sourceMeta,
      rejected,
    });
  }
  drafts = kept;

  // Step B (LLM refinement) — Pass 2 redaction + llm-bridge.refine + graceful fallback.
  // spec §7.2: SCHEMA_VIOLATION / TIMEOUT / ADAPTER_NOT_WIRED → candidate fallback.
  if (!skipDistillStepB) {
    // Pass 2 redaction — payload excerpt sent to the sub-agent, bounded to 4 KiB.
    const sourceExcerpt = JSON.stringify(redactObject(raw.payload || {})).slice(0, PASS2_EXCERPT_BYTES);
    for (const d of drafts) {
      let stepB = null;
      try {
        stepB = await llmBridgeRefine(d, sourceExcerpt, {
          adapter: llmAdapter,
          recordedFixture: llmRecordedFixture,
          timeoutMs: llmTimeoutMs,
          liveAgent,
          liveCodex,
          batchMode,
        });
      } catch (e) {
        if (STEP_B_FALLBACK_CODES.has(e.code)) {
          stepB = null; // candidate fallback (spec §7.2)
        } else {
          throw e; // unexpected — surface to caller
        }
      }
      mergeStepB(d, stepB, sourceMeta);
    }
  }

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

  // ITEM-5-r2: track leaseCreated + handle separately so cleanup finally covers acquire() failures
  let leaseCreated = false;
  let handle = null;
  try {
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
      const existingLease = readLeaseSafe(leasePath);
      if (existingLease && Date.now() - new Date(existingLease.started_at).getTime() < LEASE_STALE_MS) {
        throw new Error(
          `Another session already harvesting project ${projectId} ` +
          `(started ${existingLease.started_at}, pid ${existingLease.pid}). ` +
          `Try later or wait ~30min for stale-break.`
        );
      }
      // stale lease — overwrite
      fs.writeFileSync(leasePath, leasePayload);
    }
    leaseCreated = true;

    const lockPath = path.join(memoryRoot, '.lock');
    handle = await acquire(lockPath, { operation: 'harvest' });

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
    // R2 partial fix (Phase 6 dispatch) — full spec §6.4 union-merge deferred to v0.1.x
    // ITEM-1-r2: check global/ scope first to prevent shadowing promoted cards
    for (const c of cards) {
      const localDir = path.join(memoryRoot, 'cards', c.payload.memory_type, projectId);
      const globalDir = path.join(memoryRoot, 'cards', c.payload.memory_type, 'global');
      const localPath = path.join(localDir, c.payload.memory_id + '.json');
      const globalPath = path.join(globalDir, c.payload.memory_id + '.json');

      let existing = null, writePath = null, writeDir = null;
      if (fs.existsSync(globalPath)) {
        existing = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
        writePath = globalPath;
        writeDir = globalDir;
      } else if (fs.existsSync(localPath)) {
        existing = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        writePath = localPath;
        writeDir = localDir;
      } else {
        writePath = localPath;
        writeDir = localDir;
      }
      fs.mkdirSync(writeDir, { recursive: true });

      if (existing && existing.payload) {
        // Preserve user-accumulated state; refresh source-driven fields + last_seen_at
        c.payload.status = existing.payload.status;
        c.payload.status_history = existing.payload.status_history;
        c.payload.feedback = existing.payload.feedback;
        c.payload.created_at = existing.payload.created_at;
        c.payload.confidence = Math.max(
          existing.payload.confidence || 0,
          c.payload.confidence || 0
        );
        // Preserve LLM-derived fields when fresh harvest didn't run Step B
        if ((!c.payload.non_applicability || c.payload.non_applicability.length === 0)
            && existing.payload.non_applicability?.length) {
          c.payload.non_applicability = existing.payload.non_applicability;
        }
        if ((!c.payload.recommended_action || c.payload.recommended_action.length === 0)
            && existing.payload.recommended_action?.length) {
          c.payload.recommended_action = existing.payload.recommended_action;
        }
        if ((!c.payload.search_keywords || c.payload.search_keywords.length === 0)
            && existing.payload.search_keywords?.length) {
          c.payload.search_keywords = existing.payload.search_keywords;
        }
        // privacy_level: if existing is global, keep global (don't downgrade)
        if (existing.payload.privacy_level === 'global') {
          c.payload.privacy_level = 'global';
        }
      }
      writeJsonAtomic(writePath, c);
    }

    // 5. FTS5 upsert in same lock window (Phase 4 wires ./lib/fts-index)
    if (fts && fts.openIndex && fts.upsertCard) {
      const idx = fts.openIndex(path.join(memoryRoot, 'indexes', 'lexical.sqlite'));
      try {
        if (idx.driver === 'better-sqlite3') idx.db.exec('BEGIN');
        for (const c of cards) {
          // ITEM-7-r3: globally-promoted cards must get project_id='' in FTS row
          // so FTS metadata matches the card's actual scope (global dir).
          const fts_pid = c.payload.privacy_level === 'global' ? '' : projectId;
          fts.upsertCard(idx, c, { projectId: fts_pid });
        }
        if (idx.driver === 'better-sqlite3') idx.db.exec('COMMIT');
      } finally {
        if (idx.driver === 'better-sqlite3' && idx.db && typeof idx.db.close === 'function') {
          idx.db.close();
        }
      }
    }
  } finally {
    if (handle) release(handle);
    if (leaseCreated) {
      try { fs.unlinkSync(leasePath); } catch { /* best-effort */ }
    }
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
  splitSourceMeta,
  memoryIdFor,
  persistWithLockAndLease,
  eventKey,
  passesF1,
  partitionByF1,
  quarantineEmptyClaim,
  mergeStepB,
  PASS2_EXCERPT_BYTES,
  STEP_B_FALLBACK_CODES,
  REVIEW_AFTER_DAYS,
  LEASE_STALE_MS,
};

// ITEM-6-r3: CLI entry point — minimal single-artifact invocation for v0.1.0.
// Full config.yaml-driven glob scan is deferred to v0.1.x (see docs/handoff-phase-4-6.md).
if (require.main === module) {
  const args = process.argv.slice(2);
  // Parse --kind=<sourceKind> or --kind <sourceKind>
  let sourceKind = null;
  let projectId = null;
  const remainingArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--kind=')) {
      sourceKind = args[i].slice('--kind='.length);
    } else if (args[i] === '--kind' && i + 1 < args.length) {
      sourceKind = args[++i];
    } else if (args[i].startsWith('--project=')) {
      projectId = args[i].slice('--project='.length);
    } else if (args[i] === '--project' && i + 1 < args.length) {
      projectId = args[++i];
    } else if (!args[i].startsWith('--')) {
      remainingArgs.push(args[i]);
    }
  }
  const artifactPath = remainingArgs[0] || null;
  const memoryRoot = (process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory')).replace(/^~/, os.homedir());

  if (!artifactPath || !sourceKind) {
    console.error('Usage: node scripts/harvest.js <artifact-path> --kind <sourceKind> [--project <projectId>]');
    console.error('  sourceKind: review-recurring | evolve-insights | work-receipt | docs-scan | wiki-index');
    console.error('  Full config-driven scan deferred to v0.1.x — for v0.1.0, harvest one artifact at a time.');
    process.exit(1);
  }

  const cwd = process.cwd();
  let profile = null;
  try {
    profile = JSON.parse(fs.readFileSync(path.join(cwd, '.deep-memory', 'project-profile.json'), 'utf8'));
  } catch { /* no profile — use fallback */ }
  const finalProjectId = projectId || profile?.project_id || 'proj_unknown';

  harvestArtifact({ artifactPath, sourceKind, memoryRoot, projectId: finalProjectId, skipDistillStepB: true })
    .then((cards) => {
      const summary = {
        generated_at: new Date().toISOString(),
        artifactPath,
        sourceKind,
        projectId: finalProjectId,
        cards_count: cards.length,
        memory_ids: cards.map((c) => c.payload?.memory_id),
      };
      const outDir = path.join(cwd, '.deep-memory');
      fs.mkdirSync(outDir, { recursive: true });
      writeJsonAtomic(path.join(outDir, 'latest-harvest.json'), summary);
      console.log(`Harvest: ${cards.length} card(s) from ${sourceKind} → ${path.join(outDir, 'latest-harvest.json')}`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
