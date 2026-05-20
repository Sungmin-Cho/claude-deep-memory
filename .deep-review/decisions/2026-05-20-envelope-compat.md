# Decision — suite M3 envelope compat (Task 1.0a)

Probe result: option (b), additionalProperties=false, allowed_keys=[path, run_id]
Decision: option (b) — keep `envelope.provenance.source_artifacts[]` minimal (`path`, `run_id` only) and move deep-memory specific provenance fields into a new payload-level field `payload.deep_memory_provenance: [{id, content_hash, captured_at, artifact_kind, schema_version, source_index}]`. `source_index` is an integer index into `envelope.provenance.source_artifacts[]` to preserve the cross-reference linkage.
Affects: Task 1.1 (memory-card schema — add `deep_memory_provenance` to payload, restrict `source_artifacts[]`), Task 1.2 (memory-event schema — same envelope shape constraints), Task 2.4 (harvest.js — split source-of-truth into two structures), Task 3a.* (mapper output — emit both arrays), Task 4.6 (cross-ref invariant test — verify `source_id`/`src_\d+` resolves through `deep_memory_provenance.source_index` → `source_artifacts[index]`).
Cross-reference shape: payload-level fields (`applicability[].source_id`, `non_applicability[].source_id`) continue to use `src_\d+` pattern; the resolver walks `payload.deep_memory_provenance[]` (matched by `id`), then looks up `envelope.provenance.source_artifacts[source_index]` for the path/run_id.
Date: 2026-05-20
