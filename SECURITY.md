# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-memory. Please
upgrade to the most recent version before reporting an issue.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/claude-deep-memory/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-memory persists distilled operational memory to disk, so privacy is a core
part of its threat model. The following invariants are enforced by design:

- **Automatic hook capture is OFF by default.** Capture records tool I/O under
  `~/.deep-memory/` (override with `DEEP_MEMORY_ROOT`) and is only enabled by an
  explicit opt-in: `/deep-memory-init --enable-capture` (revert with
  `--disable-capture`). The toggle is global, and every real transition is written
  to the audit log. Manual paths (`/deep-memory-harvest`, `/deep-memory-brief`) work
  with capture left off.
- **Redaction runs before persistence.** A multi-pass rule-based redaction pipeline
  (homedir, environment variables, stack-trace paths, and other patterns) is applied
  to inputs and to the envelope wrap, so secrets and absolute paths are scrubbed
  before anything — including degraded-mode warning strings — reaches disk.
- **Cards default to `privacy_level: local`.** Memory stays scoped to its originating
  project; `--promote <id>` is the only path that moves a card to global scope.
- **User deny patterns** can be added in `suppressions.yaml` to drop content from
  capture and distillation.
- **Mutation is slash-only.** The bundled MCP server exposes read/search tools, but
  forget / promote / export mutations are gated to explicit slash-command invocation
  and each emits audit-log entries.

When reporting, please indicate which runtime (Claude Code / Codex / other) and
which path (capture hook, harvest, brief, MCP server) is affected.
