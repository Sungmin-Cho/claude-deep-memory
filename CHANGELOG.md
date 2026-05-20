# Changelog

All notable changes to deep-memory are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-20

### Added (MVP — Phase 0-3 of design spec)

- Two manifests (Claude Code + Codex) with skill-based entry surfaces
- 4 user-invocable skills (`deep-memory-init`, `deep-memory-harvest`, `deep-memory-brief`, `deep-memory-audit`) + 1 reference skill (`memory-schema`)
- Hybrid distill pipeline: rule-based Step A (5 memory types) + LLM sub-agent Step B with graceful fallback to candidate status
- Cross-runtime LLM adapter bridge (claude-agent / codex-bash / gemini-sdk / stdin-fallback)
- M3 envelope-wrapped events + cards + briefs
- sqlite FTS5 lexical retrieval with 6-stage ranking (hard filter / project sim / task sim / evidence quality / applicability guard / diversity)
- 3-pass rule-based redaction (Step A input / Step B input / envelope wrap)
- `privacy_level: local | global` per-card with explicit `--promote` gate
- Atomic write (temp+fsync+rename+readback validate) + mkdir-based lock with `{pid, host, created_at}` metadata + stale detect (>5min) + `--unlock` recovery
- Project lease with idempotent event keys (sha256(path+content_hash+run_id))
- 12 test suites including `runtime-contract/` per-adapter fixtures
- Suite integration: `deep-suite/.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json` + `suite-extensions.json` entries
