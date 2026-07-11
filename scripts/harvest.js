// scripts/harvest.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { v2LexicalIndexPath } = require('./lib/v2-index-paths');
const { resolveProjectScope } = require('./lib/project-resolver');
const { createHash } = require('node:crypto');
const { wrap } = require('./lib/envelope');
const { redactObject, redactString } = require('./lib/redact');
const { dedupeKey } = require('./lib/dedupe');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { hashFile } = require('./lib/source-hash');
const { acquire, release } = require('./lib/lock');
const { refine: llmBridgeRefine } = require('./lib/llm-bridge');
const { validateProjectId } = require('./lib/validate-project-id');

const REVIEW_AFTER_DAYS = 90;
const LEASE_STALE_MS = 30 * 60 * 1000; // 30 min — spec §"Phase 2 Task 2.5"
const PASS2_EXCERPT_BYTES = 4096; // spec §7.2 — bounded LLM input
const STEP_B_FALLBACK_CODES = new Set(['SCHEMA_VIOLATION', 'TIMEOUT', 'ADAPTER_NOT_WIRED', 'UNKNOWN_ADAPTER']);

// FTS5 index module — graceful degradation (v0.1.2). On Node v26+ where
// better-sqlite3 prebuilt binaries are unavailable AND the plugin cache is
// immutable, harvest must still write cards/events to disk; only the FTS5
// upsert is skipped and an explicit warning surfaces. /deep-memory-brief
// returns empty + warning in the same regime. sql.js WASM fallback is the
// proper fix and is deferred to v0.2.0 (see docs/handoff-phase-4-6.md).
//
// Round-5 ITEM-4 (hard-throw on FTS5 require failure) had the right intent
// for environments where the user CAN fix the build, but was the wrong
// posture for plugin-cache environments where rebuild is impossible. The
// warning surfaced both here and in brief is loud enough to flag the
// degradation without forcing a hard-fail on first use.
const FTS_DEGRADED_WARNING =
  'FTS5 lexical index unavailable (better-sqlite3 not loadable in this Node ' +
  'environment). harvest continues — cards and events are written to disk — ' +
  'but /deep-memory-brief will return empty results until the index is ' +
  'restored (use Node 22 LTS, or wait for v0.2.0 sql.js fallback). ' +
  'See README.md > Troubleshooting.';
let fts = null;
let ftsLoadError = null;
try {
  fts = require('./lib/fts-index');
} catch (e) {
  ftsLoadError = e && e.message ? e.message : String(e);
}

/**
 * Truncate a string to N chars (no ellipsis) — used for title generation
 * where deterministic length cap matters more than display.
 */
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : s.slice(0, n);
}

/**
 * spec §7.1 — Step A mapper for `.deep-review/recurring-findings.json`.
 *
 * Sibling-real payload (deep-review v1.4.0+): `payload.findings[]` where each item is
 *   { category, severity, occurrences, example_files[], description, source_reports[] }.
 *   There is no `title` / `evidence` / `first_seen` / `tags` at the finding level —
 *   those existed only in the ideal-shape spec, not in the sibling's actual emit.
 *
 *   claim source: finding.description (F1 — primary deterministic claim)
 *   title: first 80 chars of description (truncated)
 *   evidence_summary: finding.example_files (already file:line strings — max 5)
 *   applicability: [{value: 'category=<category>', source_id, confidence: 0.7}]
 *   tags: [category, severity] filtered for truthy
 *   created_at: envelope.generated_at fallback to now
 */
function mapRecurringFindings(artifact, sourceMeta) {
  const findings = artifact.payload?.findings || [];
  const generatedAt = artifact.envelope?.generated_at;
  return findings.map((f) => ({
    memory_type: 'failure-case',
    title: truncate(f.description || '', 80),
    claim: f.description || '',
    evidence_summary: Array.isArray(f.example_files) ? f.example_files.slice(0, 5) : [],
    applicability: f.category
      ? [{ value: `category=${f.category}`, source_id: sourceMeta.id, confidence: 0.7 }]
      : [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: [f.category, f.severity].filter(Boolean),
    created_at: generatedAt || new Date().toISOString(),
  }));
}

/**
 * spec §7.1 — Step A mapper for `.deep-evolve/*\/evolve-insights.json`.
 *
 * Sibling-real payload (deep-evolve v3.2.0+):
 *   payload.{
 *     updated_at,
 *     insights_for_deep_work[]:   { pattern, evidence, source_archive_ids[], suggestion },
 *     insights_for_deep_review[]: { pattern, evidence, source_archive_ids[], suggestion },
 *   }
 *   Note: no `strategy` / `outcome` / `project_signature` / `q_delta` at the item
 *   level — those existed only in the ideal-shape spec.
 *
 *   Strategy: union both arrays; tag indicates target ('for-deep-work' / 'for-deep-review').
 *   claim source: insight.suggestion (most actionable, F1)
 *   title: insight.pattern (truncated 80)
 *   evidence_summary: [insight.evidence, ...insight.source_archive_ids].slice(0, 5)
 *   applicability: empty (no project_signature in real shape)
 *   confidence: 0.5 default (no q_delta to normalize)
 *   tags: ['evolve', 'for-deep-work'|'for-deep-review']
 */
function mapEvolveInsights(artifact, sourceMeta) {
  const payload = artifact.payload || {};
  const generatedAt = artifact.envelope?.generated_at;
  const targets = [
    { tag: 'for-deep-work', items: payload.insights_for_deep_work || [] },
    { tag: 'for-deep-review', items: payload.insights_for_deep_review || [] },
  ];
  const out = [];
  for (const { tag, items } of targets) {
    for (const i of items) {
      const evidence = [];
      if (typeof i.evidence === 'string' && i.evidence.length > 0) evidence.push(i.evidence);
      if (Array.isArray(i.source_archive_ids)) {
        for (const sid of i.source_archive_ids.slice(0, 4)) evidence.push(sid);
      }
      out.push({
        memory_type: 'experiment-outcome',
        title: truncate(i.pattern || '', 80),
        claim: i.suggestion || i.pattern || '',
        evidence_summary: evidence.slice(0, 5),
        applicability: [],
        non_applicability: [],
        recommended_action: i.suggestion ? [i.suggestion] : [],
        search_keywords: [],
        tags: ['evolve', tag],
        confidence: 0.5,
        created_at: generatedAt || new Date().toISOString(),
      });
    }
  }
  return out;
}

/**
 * spec §7.1 — Step A mapper for `.deep-work/*\/session-receipt.json`.
 *
 * Sibling-real payload (deep-work v6.5.0+): `payload.slices` is an aggregate object
 *   `{ total, completed, spike }`, NOT an array. Per-slice receipts live in separate
 *   files at `<sid>/receipts/SLICE-*.json`.
 *
 *   Strategy: Option A — 1 card per session-receipt summarising the whole session.
 *   Slice-level memory is deferred (would require source-kind reconfiguration).
 *
 *   Memory type branches on `payload.outcome`:
 *     'merge' / 'pr' / 'keep' → pattern
 *     'discard' / 'abandon'   → failure-case
 *     other (or undefined)    → pattern (default to "we learned something")
 *
 *   claim source: deterministic summary string built from task_description + outcome
 *     + quality_score + slices.completed/total (F1 — never empty as long as
 *     task_description or session_id is present)
 *   title: task_description (truncated 80)
 *   evidence_summary: [session_id] (deterministic single source)
 *   tags: ['deep-work', 'session', outcome]
 *   confidence: quality_score / 10 (clamped to [0, 1]) — default 0.5 if absent
 */
function mapWorkReceipt(artifact, sourceMeta) {
  const p = artifact.payload || {};
  const generatedAt = artifact.envelope?.generated_at;
  const outcome = p.outcome || 'unknown';
  const failureOutcomes = new Set(['discard', 'abandon']);
  const memoryType = failureOutcomes.has(outcome) ? 'failure-case' : 'pattern';

  const taskDesc = p.task_description || p.session_id || '';
  const slices = p.slices || {};
  const completed = typeof slices.completed === 'number' ? slices.completed : 0;
  const total = typeof slices.total === 'number' ? slices.total : 0;
  const qs = typeof p.quality_score === 'number' ? p.quality_score : null;

  const verbPrefix = memoryType === 'failure-case' ? 'Failure' : 'Pattern';
  const claimParts = [
    `${verbPrefix}: ${taskDesc}`,
    qs !== null ? `quality ${qs.toFixed(1)}/10` : null,
    total > 0 ? `${completed}/${total} slices completed` : null,
    `outcome=${outcome}`,
  ].filter(Boolean);

  const evidence = [];
  if (p.session_id) evidence.push(p.session_id);

  return [{
    memory_type: memoryType,
    title: truncate(taskDesc, 80),
    claim: claimParts.join(' — '),
    evidence_summary: evidence,
    applicability: [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: ['deep-work', 'session', outcome],
    confidence: qs !== null ? Math.max(0, Math.min(1, qs / 10)) : 0.5,
    created_at: generatedAt || p.finished_at || new Date().toISOString(),
  }];
}

/**
 * spec §7.1 — Step A mapper for `.deep-docs/last-scan.json`.
 *
 * Sibling-real payload (deep-docs v1.3.1+): `payload.documents[].issues[]` (nested).
 *   Each document = { path, issues[], metrics }
 *   Each issue   = { type, category, severity, line, current_value, suggested_value, evidence }
 *
 *   Strategy: flatten — each issue becomes 1 card.
 *   claim source: `${issue.type} at ${document.path}:${issue.line} — ${issue.evidence}` (F1)
 *   title: `${issue.type} in ${document.path}` (truncated 80)
 *   evidence_summary: [`${document.path}:${issue.line}`]
 *   applicability: [{value: `category=${issue.category}`, confidence: 0.6}]
 *   recommended_action: [issue.suggested_value] if present
 *   tags: ['deep-docs', issue.category, issue.severity] filtered
 *   confidence: severity-mapped (high=0.7, medium=0.5, low=0.3) — default 0.5
 */
function mapDocsScan(artifact, sourceMeta) {
  const docs = artifact.payload?.documents || [];
  const generatedAt = artifact.envelope?.generated_at;
  const SEVERITY_CONFIDENCE = { high: 0.7, medium: 0.5, low: 0.3 };
  const out = [];
  for (const doc of docs) {
    const docPath = doc.path || '';
    const issues = Array.isArray(doc.issues) ? doc.issues : [];
    for (const issue of issues) {
      const issueType = issue.type || '';
      const location = issue.line != null ? `${docPath}:${issue.line}` : docPath;
      const evidenceText = issue.evidence || issue.suggested_value || '';
      const claim = evidenceText
        ? `${issueType} at ${location} — ${evidenceText}`
        : `${issueType} at ${location}`;
      out.push({
        memory_type: 'coding-style',
        title: truncate(issueType ? `${issueType} in ${docPath}` : docPath, 80),
        claim,
        evidence_summary: location ? [location] : [],
        applicability: issue.category
          ? [{ value: `category=${issue.category}`, source_id: sourceMeta.id, confidence: 0.6 }]
          : [],
        non_applicability: [],
        recommended_action: issue.suggested_value ? [issue.suggested_value] : [],
        search_keywords: [],
        tags: ['deep-docs', issue.category, issue.severity].filter(Boolean),
        confidence: SEVERITY_CONFIDENCE[issue.severity] ?? 0.5,
        created_at: generatedAt || new Date().toISOString(),
      });
    }
  }
  return out;
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

/**
 * Envelope contract per source kind — MUST stay in sync with
 * `scripts/lib/default-config.js` `sources[*]` (producer / artifact_kind /
 * supported_schema_versions). Consumed by the harvest envelope guard.
 */
const SOURCE_CONTRACTS = {
  'review-recurring': { producer: 'deep-review', artifact_kind: 'recurring-findings', supported_schema_versions: ['1.0'] },
  'evolve-insights':  { producer: 'deep-evolve', artifact_kind: 'evolve-insights',    supported_schema_versions: ['1.0'] },
  'work-receipt':     { producer: 'deep-work',   artifact_kind: 'session-receipt',     supported_schema_versions: ['1.0'] },
  'docs-scan':        { producer: 'deep-docs',   artifact_kind: 'last-scan',           supported_schema_versions: ['1.0'] },
  'wiki-index':       { producer: 'deep-wiki',   artifact_kind: 'wiki-index',          supported_schema_versions: ['1.0'] },
};

/**
 * Envelope contract guard (SKILL.md Step 4: "producer / artifact_kind /
 * schema_version 헤더 확인 → mis-match 면 skip + warning"). Returns {ok:true}
 * when the artifact's M3 envelope header is consistent with the source kind's
 * contract, or {ok:false, warning} on a POSITIVE mismatch — a present envelope
 * field that disagrees, or a present schema.version whose MAJOR is outside the
 * supported majors derived from supported_schema_versions.
 *
 * Version is compared at MAJOR granularity: a minor bump is additive and
 * backward-compatible by SemVer convention (verified in practice — deep-docs
 * emits last-scan schema 1.1 while the config still declares 1.0, and the
 * docs-scan mapper handles it), so 1.1 passes against a supported "1.0" but a
 * breaking 2.0 is rejected. An absent envelope / absent field is tolerated
 * (legacy unwrapped artifact); the guard rejects only artifacts that actively
 * declare a different producer/kind or an unsupported MAJOR schema revision
 * (sibling schema drift), which would otherwise map to zero/garbage cards
 * silently.
 */
function majorOf(version) {
  return String(version).split('.')[0];
}

// Supported M3 envelope WRAPPER major (top-level `schema_version` — the
// envelope format version, independent of the per-payload `envelope.schema
// .version` checked against SOURCE_CONTRACTS). The suite locks the wrapper
// schema at 1.x; a 2.x wrapper is a format this reader does not understand.
const ENVELOPE_WRAPPER_SUPPORTED_MAJOR = '1';

// This guard runs BEFORE Pass 1 redaction (the artifact is still raw), and its
// warning is mirrored to disk in `latest-harvest.json` — so every external
// header value echoed into the warning must be redacted and bounded here
// (same privacy invariant as the ftsLoadError handling below).
function safeHeaderValue(value) {
  return redactString(String(value).slice(0, 120));
}

function checkEnvelopeContract(raw, sourceKind) {
  const contract = SOURCE_CONTRACTS[sourceKind];
  if (!contract) return { ok: true }; // unknown kind is handled by the mapper existence check
  const env = (raw && raw.envelope) || {};
  const producer = env.producer;
  const artifactKind = env.artifact_kind;
  const version = env.schema && env.schema.version;
  const wrapperVersion = raw && raw.schema_version;
  const problems = [];
  if (producer != null && producer !== contract.producer) {
    problems.push(`producer '${safeHeaderValue(producer)}' != expected '${contract.producer}'`);
  }
  if (artifactKind != null && artifactKind !== contract.artifact_kind) {
    problems.push(`artifact_kind '${safeHeaderValue(artifactKind)}' != expected '${contract.artifact_kind}'`);
  }
  if (version != null) {
    const supportedMajors = new Set(contract.supported_schema_versions.map(majorOf));
    if (!supportedMajors.has(majorOf(version))) {
      problems.push(`schema.version '${safeHeaderValue(version)}' major not in supported [${contract.supported_schema_versions.join(', ')}]`);
    }
  }
  // Top-level wrapper version: only meaningful on an envelope-shaped artifact.
  // NOTE: wrapper and payload schema versions are independent by M3 design —
  // no equality cross-check between them (a 1.x wrapper may carry any
  // supported payload schema).
  if (raw && raw.envelope && wrapperVersion != null && majorOf(wrapperVersion) !== ENVELOPE_WRAPPER_SUPPORTED_MAJOR) {
    problems.push(`schema_version '${safeHeaderValue(wrapperVersion)}' wrapper major not supported (expected ${ENVELOPE_WRAPPER_SUPPORTED_MAJOR}.x)`);
  }
  if (problems.length > 0) {
    return { ok: false, warning: `envelope_mismatch (${sourceKind}): ${problems.join('; ')} — artifact skipped` };
  }
  return { ok: true };
}

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
    // ITEM-2-r5: redact sourceMeta.path before writing quarantine file — symmetric with
    // round-1 ITEM-2 (cards) and round-4 ITEM-4 (events JSONL). Home dir must not leak
    // into any deep-memory output file (spec §11.1 privacy invariant).
    source: {
      ...sourceMeta,
      path: redactString(sourceMeta.path),
    },
    rejected_count: rejected.length,
    rejected,
  };
  writeJsonAtomic(file, payload);
}

function buildSourceMeta(artifactPath, raw, sourceKind) {
  // ITEM-3-r5: resolve relative paths to absolute so provenance is stable across cwd changes.
  // audit cross-cwd would resolve relative paths against THAT cwd → false-positive missing/drift.
  // After redaction (ITEM-2 r1), the absolute path becomes ~/... which expandTilde in audit handles.
  const resolvedPath = path.resolve(artifactPath);
  return {
    id: 'src_0',
    path: resolvedPath,
    content_hash: hashFile(resolvedPath),
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

function buildCardFromDraft(draft, sourceMeta, cwd = null) {
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
  // ITEM-4-r5: thread cwd to wrap so gitStateSafe captures the correct repo's git state
  // when process.cwd() differs from the project directory (SDK-style invocation).
  return wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload,
    provenance: { source_artifacts: redactedSourceArtifacts },
    cwd,
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
  cwd = null,  // ITEM-4-r5: optional cwd for gitStateSafe in envelope
}) {
  // ITEM-2-r4: validate projectId at entry boundary before any path.join site
  validateProjectId(projectId);
  const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const sourceMeta = buildSourceMeta(artifactPath, raw, sourceKind);
  const mapper = STEP_A_MAPPERS[sourceKind];
  if (!mapper) throw new Error(`Unknown sourceKind: ${sourceKind}`);

  // Envelope contract guard — skip (do NOT persist) a sibling artifact whose
  // M3 envelope header disagrees with this source kind's contract, recording a
  // warning instead of silently mapping schema-drifted input to zero/garbage
  // cards. Returns an empty card array carrying non-enumerable `skipped` +
  // `warnings` so the CLI mirrors both into latest-harvest.json.
  const contractCheck = checkEnvelopeContract(raw, sourceKind);
  if (!contractCheck.ok) {
    const skipped = [];
    Object.defineProperty(skipped, 'skipped', {
      enumerable: false, configurable: true, writable: true, value: true,
    });
    Object.defineProperty(skipped, 'warnings', {
      enumerable: false, configurable: true, writable: true, value: [contractCheck.warning],
    });
    return skipped;
  }

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

  const cards = drafts.map((d) => buildCardFromDraft(d, sourceMeta, cwd));

  await persistWithLockAndLease({ memoryRoot, projectId, cards, sourceMeta });
  // Attach degraded-mode warning as a non-enumerable property on the array so
  // callers that destructure or iterate cards are unaffected, but the CLI /
  // skill harness can surface it via `Array.isArray(out) && out.warnings`.
  // v0.1.3 — the native loader error may embed absolute paths (e.g.
  // `Cannot find module '/Users/.../better-sqlite3.node'`). Route through
  // redactString to honor the repo's 3-pass privacy invariant before the
  // message is mirrored to disk in `latest-harvest.json`.
  if (!fts) {
    const causeRedacted = ftsLoadError ? redactString(ftsLoadError) : '';
    Object.defineProperty(cards, 'warnings', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: [FTS_DEGRADED_WARNING + (causeRedacted ? ` (cause: ${causeRedacted})` : '')],
    });
  }
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
  // ITEM-2-r4: defensive validation at persist boundary (harvestArtifact already validates,
  // but direct callers of persistWithLockAndLease also need the guard)
  validateProjectId(projectId);
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
        // ITEM-4-r4: redact path in event source to prevent home-directory leakage
        // into events JSONL. event_key is computed from raw sourceMeta.path BEFORE
        // this redaction (see eventKey() above), so idempotency is not affected.
        source: {
          ...sourceMeta,
          path: redactString(sourceMeta.path),
        },
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

    // 5. FTS5 upsert in same lock window (v0.1.2 — graceful degradation:
    //    `fts === null` when better-sqlite3 require failed; cards/events
    //    are still written, but the index is not populated.)
    if (fts && fts.openIndex && fts.upsertCard) {
      const idx = fts.openIndex(v2LexicalIndexPath(memoryRoot));
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
  SOURCE_CONTRACTS,
  checkEnvelopeContract,
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
  FTS_DEGRADED_WARNING,
  isFtsAvailable: () => fts !== null,
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
  const rebuildFromEvents = args.includes('--rebuild-from-events');
  if (!rebuildFromEvents && (!artifactPath || !sourceKind)) {
    console.error('Usage: node scripts/harvest.js <artifact-path> --kind <sourceKind> [--project <projectId>]');
    console.error('   OR: node scripts/harvest.js --rebuild-from-events [--session <sessionId>] [--project <projectId>]');
    console.error('  sourceKind: review-recurring | evolve-insights | work-receipt | docs-scan | wiki-index');
    console.error('  Full config-driven scan deferred to v0.1.x — for v0.1.0, harvest one artifact at a time.');
    process.exit(1);
  }
  const cwd = fs.realpathSync.native(process.cwd());
  const projectScope = resolveProjectScope(cwd);
  if (projectScope.scope !== 'project' || !projectScope.projectId) {
    console.error(`project scope unavailable: ${projectScope.warning || 'project_profile_untrusted'}`);
    process.exit(1);
  }
  if (projectId !== null && projectId !== projectScope.projectId) {
    console.error('requested project_id does not match the trusted project profile');
    process.exit(1);
  }
  const finalProjectId = projectScope.projectId;

  // IMPL-R1-G — `--rebuild-from-events --session <id>` flag for eager-distill
  // child spawned from pre-compact.mjs / session-end.mjs (per spec §3.2.1
  // fire-and-forget). Runs runLazyDistill on the session-filtered event tail.
  let sessionFilter = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--session') { sessionFilter = args[i + 1]; break; }
  }
  if (rebuildFromEvents) {
    const { runLazyDistill } = require('./lib/distill-pipeline.js');
    runLazyDistill({
      root: memoryRoot,
      projectId: finalProjectId,
      config: {
        skip_llm: true,
        distill: { detectors: { session_summary: { always_emit: false } } },
        sessionFilter
      }
    }).then((result) => {
      console.log(JSON.stringify({ status: 'rebuild_from_events_completed', ...result }));
      process.exit(0);
    }).catch((e) => {
      console.error(`rebuild-from-events failed: ${e.message}`);
      process.exit(2);
    });
    return;
  }

  harvestArtifact({ artifactPath, sourceKind, memoryRoot, projectId: finalProjectId, skipDistillStepB: true })
    .then((cards) => {
      const warnings = Array.isArray(cards.warnings) ? cards.warnings : [];
      const wasSkipped = cards.skipped === true;
      const summary = {
        generated_at: new Date().toISOString(),
        artifactPath,
        sourceKind,
        projectId: finalProjectId,
        cards_count: cards.length,
        memory_ids: cards.map((c) => c.payload?.memory_id),
        skipped: wasSkipped,
        warnings,
      };
      const outDir = path.join(cwd, '.deep-memory');
      fs.mkdirSync(outDir, { recursive: true });
      writeJsonAtomic(path.join(outDir, 'latest-harvest.json'), summary);
      console.log(wasSkipped
        ? `Harvest: SKIPPED ${sourceKind} (envelope mismatch) → ${path.join(outDir, 'latest-harvest.json')}`
        : `Harvest: ${cards.length} card(s) from ${sourceKind} → ${path.join(outDir, 'latest-harvest.json')}`);
      for (const w of warnings) console.warn(`Warning: ${w}`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
