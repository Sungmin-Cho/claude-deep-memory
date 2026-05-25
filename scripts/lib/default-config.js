'use strict';
// scripts/lib/default-config.js
// Single source of truth for the default config.yaml template. Required by
// init.js (config creation) and capture-toggle.js (absent-config fallback) —
// extracted into its own module to avoid an init.js <-> capture-toggle cycle.
//
// The `capture:` block (added in 0.3.2) MUST keep the exact shape the hook
// reader probes for: `/capture:\s*\n\s*enabled:\s*(true|false)/`
// (scripts/hooks/common.mjs). Capture defaults OFF per spec §3.6 (privacy).

function defaultConfigYaml() {
  return `version: "0.1.0"
memory_root: ~/.deep-memory
privacy:
  default_scope: local
  allow_export: false
capture:
  enabled: false
  eager_distill: false
sources:
  - kind: review-recurring
    path: ".deep-review/recurring-findings.json"
    memory_type: failure-case
    producer: deep-review
    artifact_kind: recurring-findings
    supported_schema_versions: ["1.0"]
  - kind: evolve-insights
    path: ".deep-evolve/*/evolve-insights.json"
    memory_type: experiment-outcome
    producer: deep-evolve
    artifact_kind: evolve-insights
    supported_schema_versions: ["1.0"]
  - kind: work-receipt
    path: ".deep-work/*/session-receipt.json"
    memory_type: pattern
    producer: deep-work
    artifact_kind: session-receipt
    supported_schema_versions: ["1.0"]
  - kind: docs-scan
    path: ".deep-docs/last-scan.json"
    memory_type: coding-style
    producer: deep-docs
    artifact_kind: last-scan
    supported_schema_versions: ["1.0"]
  - kind: wiki-index
    path: "<wiki_root>/.wiki-meta/index.json"
    memory_type: architecture-decision
    producer: deep-wiki
    artifact_kind: wiki-index
    supported_schema_versions: ["1.0"]
distill:
  mode: hybrid
  llm:
    adapter: auto
    timeout_ms: 30000
    max_input_bytes: 4096
    on_failure: candidate
retrieve:
  top_n: 8
  diversity_per_type: 2
  scoring:
    w_project_sim: 0.2
    w_task_sim: 0.5
    w_evidence: 0.3
    w_stale_penalty: 0.1
audit:
  stale_grace_days: 90
  profile_max_age_days: 30
  high_redaction_chars: 200
suppressions_file: ~/.deep-memory/suppressions.yaml
`;
}

module.exports = { defaultConfigYaml };
