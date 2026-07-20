# Changelog

All notable changes to deep-memory are documented here. This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] — 2026-07-20

### Fixed

- Claude Code loads the standard `hooks/hooks.json` automatically in addition to the manifest-declared hook file, so the Codex discovery hooks also fired on Claude Code with `${PLUGIN_ROOT}` unset and crashed on every SessionStart, UserPromptSubmit, PostToolUse, and PreCompact ("Failed with non-blocking status code: node:internal/modules/cjs/loader:1478"). The Codex hooks are now the same shell-safe fail-open env-bootstrap as the Claude file and delegate to `hooks/hooks.claude.json` on a Claude host, so each event is captured exactly once per runtime and never surfaces a host error.

## [1.0.3] — 2026-07-20

### Fixed

- Claude Code capture hooks now load from a dedicated hook manifest and resolve the plugin root at runtime, so every session's SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact, and SessionEnd capture runs instead of silently failing when the host leaves the plugin-root token unexpanded in an inline manifest hook.
- Capture hooks stay non-blocking and fail open: a missing plugin root, a missing capture script, or a spawn error skips capture without disrupting the session.

## [1.0.2] — 2026-07-10

### Changed

- Claude Code and Codex now use an explicit host-mediated distiller contract, and unavailable, timed-out, or rejected mediation visibly falls back to a candidate card.
- Claude Code retains its six hook events while Codex uses its four supported events with native Windows commands and the same capture semantics.
- After upgrading, initialize every workspace and then harvest again; old-scope artifacts are not migrated automatically, and non-reharvestable legacy cards remain archived under the old scope, so export or back up those cards before upgrading where applicable.

### Fixed

- Codex MCP starts from a plugin-relative bundled entrypoint and reads bundled schemas and resources without install-time dependencies.
- MCP and command-line reads use a bounded privacy-scoped card scan when native SQLite is unavailable.

## [1.0.1] - 2026-07-09

### Fixed

- Marketplace installations can complete the MCP handshake and list tools without installing dependencies at runtime.
- Optional native retrieval components load only when their features are requested, so MCP startup remains dependency-light.

## [1.0.0] - 2026-07-09

### Fixed

- Codex discovers its host-supported capture hooks from the native hook manifest.
- Runtime producer metadata stays aligned with the installed plugin version.

## [0.4.0] - 2026-07-07

### Fixed

- MCP reads fail closed when a scoped card cannot be resolved instead of reporting an empty success.
- Deferred distillation keeps a lossless file-and-offset cursor across monthly event rollover.
- Session capture no longer mutates or discards live session state.
- Harvest warnings and native-loader failures are redacted and bounded before exposure.

## [0.3.2] - 2026-05-25

### Added

- Initialization can explicitly enable or disable the global capture toggle, which remains off by default.
- Every real capture-toggle transition produces one audit entry while no-op requests remain quiet.

### Fixed

- The documented capture opt-in is now available without manually editing configuration.

## [0.3.1] - 2026-05-22

### Fixed

- MCP no longer passes unsupported shell-style default interpolation to the host, preventing a startup handshake failure.
- The patch release forces affected cached installations to fetch the corrected MCP configuration.

## [0.3.0] - 2026-05-22

### Added

- The three-layer Events, Cards, and Briefs model adds opt-in hook capture, deterministic card extraction, hybrid retrieval, and a gated MCP surface.
- Claude Code captures six lifecycle events and Codex captures its supported four-event subset only after capture is enabled.
- Read-only memory tools and explicitly gated export, promotion, and deletion skills are available across supported hosts.

### Changed

- Redaction rules are shared across capture, distillation, retrieval, and output boundaries.
- Event cursors use forward-only byte offsets and remain compatible with legacy flat events.

## [0.1.3] - 2026-05-21

### Fixed

- Degraded-mode warnings redact home-directory information before they reach cards or summaries.
- Native SQLite is optional at installation time, allowing the plugin to start when a native binding is unavailable.

## [0.1.2] - 2026-05-21

### Fixed

- Harvest continues to write cards and events when native FTS5 cannot load and surfaces an actionable degraded-mode warning.
- All sibling artifact mappers consume their emitted shapes so valid sources no longer produce silent zero-card harvests.

### Changed

- Hand-built artifacts using the former idealized mapper shapes must be regenerated; the persisted card and envelope formats are unchanged.

## [0.1.0] - 2026-05-20

### Added

- Claude Code and Codex manifests expose initialization, harvest, brief, and audit skills.
- Rule-based extraction and optional subagent refinement produce redacted local memory cards with explicit candidate fallback.
- Project leases, atomic writes, scoped storage, and explicit promotion protect memory integrity and privacy.

### Changed

- The initial lexical index is single-project-safe; users sharing one store across projects should use separate memory roots until scope-aware indexing is available.
