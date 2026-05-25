# deep-memory — `--enable-capture` / `--disable-capture` CLI toggle

**Date:** 2026-05-25
**Status:** Approved (brainstorming)
**Target version:** 0.3.2
**Author:** sungmin (with Claude)

## Problem / Root cause

The v0.3.0 spec (`2026-05-22-deep-memory-v0.3.0-design.md` §3.6) fully designed an
auto-capture opt-in toggle, but the `init.js` implementation shipped without it.
Three concrete gaps:

1. `defaultConfigYaml()` has **no `capture:` block** — a fresh `init` writes a
   `config.yaml` that lacks the capture keys entirely.
2. The CLI arg parser handles only `--allow-network-root`; any capture flag is
   silently ignored (`--`-prefixed, so not even captured as `memoryRoot`).
3. `init.js` does **not overwrite an existing `config.yaml`**
   (`if (!fs.existsSync(configPath))`), so flipping the toggle on an existing
   install requires an in-place edit.

Consequence: the only way to enable capture today is to hand-edit
`~/.deep-memory/config.yaml`. The CHANGELOG and README referenced a
`--capture` flag that was never wired up (doc/code drift).

## Decision

- **Flag names:** `--enable-capture` / `--disable-capture` (boolean flags,
  mutually exclusive). Matches spec §3.6 line 644 verbatim (so the spec needs
  no rewrite), keeps the privacy-sensitive direction explicit, and is
  consistent with the existing `--allow-network-root` boolean-flag style.
- **Scope:** CLI flag + default-config block + `capture-toggle` audit-log entry
  + doc sync + version bump (0.3.2) + `deep-suite/` marketplace sync.
  Out of scope (YAGNI for this change): interactive first-run prompt
  (`method: 'prompted'`) and a separate `--eager-distill` flag.

## Config-edit strategy

**Targeted text edit** (not YAML parse/re-serialize). Rationale: zero new
dependency, preserves comments/formatting, and — critically — the hook reader
(`scripts/hooks/common.mjs`) already detects capture via the regex
`/capture:\s*\n\s*enabled:\s*true/`. A text-edit writer that produces exactly
that shape stays byte-compatible with the reader's contract. A YAML library
would add a dependency, lose comments/ordering, and diverge from the existing
"regex probe" design philosophy.

## Architecture — single-responsibility module

New `scripts/lib/capture-toggle.js`:

```
setCaptureEnabled(root, targetBool, { by, method, host }) → { from, to, changed }
  1. Read <root>/config.yaml (if absent, write defaultConfigYaml() first, then read).
  2. from = current capture.enabled (regex probe — same pattern as common.mjs).
  3. Apply targetBool to the text:
       - capture: block present → replace the `enabled:` line within it.
       - capture: block absent  → insert
             capture:
               enabled: <bool>
               eager_distill: false
         immediately after the privacy: block.
  4. changed === (from !== to). Only when changed:
       - atomic write of config.yaml
       - audit-log writeEntry({ kind:'capture-toggle', by, host,
                                payload:{ from, to, method } })
  5. return { from, to, changed }
```

- **Idempotent:** if already at target state, `changed:false`, no file write,
  no audit entry (spec line 661: every *toggle* = actual transition only).
- Reused by `init.js` now; available to future MCP/slash paths later.
- Uses the existing `scripts/lib/audit-log.js#writeEntry`. `capture-toggle` is a
  single entry (NOT a mutation-consent pair). `by:'cli-flag'`,
  `method:'cli-flag'` — both already valid in `schemas/audit-log-entry.schema.json`.

## `init.js` changes

- `defaultConfigYaml()`: add, after the `privacy:` block:
  ```yaml
  capture:
    enabled: false
    eager_distill: false
  ```
- `run({ memoryRoot, allowNetworkRoot, capture })`: when `capture` is
  `true`/`false`, after dir + profile setup, call
  `setCaptureEnabled(resolvedRoot, capture, { by:'cli-flag', method:'cli-flag', host })`
  and include `capture:{from,to,changed}` in the returned JSON.
  When `capture` is `undefined`, behavior is unchanged.
- CLI parsing:
  ```js
  const enable  = args.includes('--enable-capture');
  const disable = args.includes('--disable-capture');
  if (enable && disable) { error → exit 1 }
  const capture = enable ? true : disable ? false : undefined;
  ```
  `memoryRoot` extraction (`args.find(a => !a.startsWith('--'))`) already
  excludes the new flags.

## Error handling

- `--enable-capture --disable-capture` together → exit 1 with a clear message.
- Corrupt `config.yaml` where the `capture:` block can't be matched → fall back
  to the insert path, guarding against duplicate-key insertion (conservative
  block detection).
- audit-log write failure is non-fatal: surface a warning, do not crash init.

## Tests (TDD)

`tests/` additions:

1. Fresh config + `--enable-capture` → `capture.enabled: true`, 1 audit entry,
   `changed:true`.
2. Already-enabled config + `--enable-capture` → `changed:false`, 0 audit
   entries (idempotent).
3. `--disable-capture` → false transition, audit payload `{from:true,to:false}`.
4. Both flags together → throws / exit 1.
5. `defaultConfigYaml()` contains `capture.enabled:false` + `eager_distill:false`.
6. **Hook-contract regression (most important invariant):** after a toggle,
   `common.mjs#isCaptureEnabled()`'s regex reads the written value correctly —
   the writer and reader must agree on the exact text shape.

## Documentation sync

- `skills/deep-memory-init/SKILL.md` — Inputs table + a toggle Step + Outputs
  `capture` field.
- `README.md` / `README.ko.md` — quick-start + privacy sections gain the
  `--enable-capture` / `--disable-capture` guidance (capture is currently
  unmentioned in the README).
- `CHANGELOG.md` / `CHANGELOG.ko.md` — new `0.3.2` entry: "Fixed: capture toggle
  flag never implemented → `--enable-capture`/`--disable-capture` implemented".
- Spec: no edit needed (§3.6 already names `--enable-capture`).
- `CLAUDE.md` Privacy invariant — optional one-line note on capture default-OFF
  + toggle path.

## Release

Per `CLAUDE.md` cross-repo workflow:
- Bump `0.3.1 → 0.3.2` in `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json`
  + `package.json` (manifest-drift CI).
- Sync `deep-suite/` marketplace.json ×2 (sha + description) +
  `suite-extensions.json` if artifacts/data_flow change.
