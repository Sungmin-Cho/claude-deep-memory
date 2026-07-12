**English** | [한국어](./README.ko.md)

# deep-memory

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-memory?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-memory)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

> Cross-project semantic operational memory for the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

deep-memory harvests sibling-plugin artifacts, distills reusable memory cards, and supplies task-specific briefs to later work. It supports Claude Code and Codex natively while keeping capture opt-in and project-scoped. See the [CHANGELOG](CHANGELOG.md) for release history.

## Install

Node 22 is required. Native Windows 11, macOS, and Linux are supported; Windows does not require Git Bash.

### Claude Code

```text
/plugin install deep-memory@claude-deep-suite
```

### Codex

```text
codex plugin add deep-memory@claude-deep-suite
```

## Quick start

Claude Code uses slash skills:

```text
/deep-memory-init
/deep-memory-harvest
/deep-memory-brief "implement a Codex-compatible plugin"
/deep-memory-audit
```

Codex uses namespaced skills:

```text
$deep-memory:deep-memory-init
$deep-memory:deep-memory-harvest
$deep-memory:deep-memory-brief "implement a Codex-compatible plugin"
$deep-memory:deep-memory-audit
```

Automatic hook capture is **OFF by default**. Enable it explicitly with the init skill's `--enable-capture` option; manual harvest and brief flows work while capture stays off.

## Three-layer model

1. **Events** — append-only captured or harvested observations.
2. **Cards** — redacted, project-scoped semantic memory with loss-averse lifecycle state.
3. **Briefs** — ranked task context produced from native FTS5 or a bounded card-scan fallback.

## Skills

| Skill | Purpose |
|---|---|
| `deep-memory-init` | initialize the memory root and trusted project profile |
| `deep-memory-harvest` | map sibling artifacts, run optional Step B refinement, and persist cards |
| `deep-memory-brief` | retrieve a scoped task brief |
| `deep-memory-audit` | inspect schema, lifecycle, locks, and store health |
| `deep-memory-export` | export cards for backup or transfer |
| `deep-memory-promote` | promote an explicitly selected local card |
| `deep-memory-forget` | delete an explicitly confirmed card |

## Privacy

- Three redaction boundaries cover source input, host-mediated refinement input, and persisted output.
- New cards default to `privacy_level: local`; promotion is explicit.
- Capture is **OFF by default**, and every real toggle is audited.
- Host-mediated Step B receives only a redacted event draft and a redacted excerpt capped at 4,096 UTF-8 bytes.

## Cross-runtime

- Claude Code retains six hook events; Codex uses the four events its host supports. Both surfaces share capture semantics and native Node commands.
- Claude Code routes Step B to the named read-only distiller agent. Codex routes it through a generic subagent that first reads the same authoritative agent contract.
- The mediator is an explicit shell-free executable JSON process contract. Missing, invalid, or timed-out mediation is recorded as a candidate fallback.
- Native FTS5 is the primary lexical index. When native SQLite is unavailable, reads use a privacy-scoped bounded card-scan fallback instead of returning an empty brief.

## Support and recovery

After upgrading, initialize every workspace and then harvest again. Old-scope artifacts are not migrated automatically or re-associated, and non-reharvestable legacy cards remain archived under their old scope; export or back up those cards before upgrading where applicable.

Run Node 22 on native Windows 11, macOS, or Linux. If a host mediator is unavailable, harvest still persists a candidate and records a typed warning in `.deep-memory/latest-harvest.json`. For security reporting, see [SECURITY.md](SECURITY.md).

## Links

- [Release history](CHANGELOG.md)
- [Contribution guide](CONTRIBUTING.md)
- [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)

## License

MIT
