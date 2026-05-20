// scripts/harvest.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { wrap } = require('./lib/envelope');
const { redactObject } = require('./lib/redact');
const { dedupeKey } = require('./lib/dedupe');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { hashFile } = require('./lib/source-hash');

const REVIEW_AFTER_DAYS = 90;

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

// Phase 3a will register mapEvolveInsights, mapWorkReceipt, mapDocsScan, mapWikiIndex here
// (one task per mapper per plan §"Phase 3a" / spec §7.1).
const STEP_A_MAPPERS = {
  'review-recurring': mapRecurringFindings,
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
    confidence: 0.5,
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

  // Phase 2 simplified persist — Task 2.5 wraps this in lease + lock + idempotent event + FTS5.
  for (const c of cards) {
    const dir = path.join(memoryRoot, 'cards', c.payload.memory_type, projectId);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, c.payload.memory_id + '.json'), c);
  }
  return cards;
}

module.exports = {
  harvestArtifact,
  mapRecurringFindings,
  STEP_A_MAPPERS,
  buildCardFromDraft,
  buildSourceMeta,
  memoryIdFor,
  REVIEW_AFTER_DAYS,
};
