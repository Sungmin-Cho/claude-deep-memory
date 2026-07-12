# Contributing to deep-memory

Thanks for improving **deep-memory**, the cross-project operational-memory plugin in [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

## Development setup

```text
git clone https://github.com/Sungmin-Cho/claude-deep-memory.git
cd claude-deep-memory
npm install
```

Node 22 is the supported runtime on Windows, macOS, and Linux. Native SQLite is optional; when it is unavailable, the supported read path is the bounded card-scan fallback.

## Verification

Run the portable release gates in this order:

```text
npm run build:mcp
git diff --exit-code -- dist/mcp-server.cjs
npm run validate-manifest
npm test
```

The committed MCP bundle must be deterministic. Build it again and repeat the bundle drift check before release.

Maintainers also run the official Codex schema validator from the installed system skill:

```text
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

That Python command is a local maintainer-only schema gate, not supported runtime or ordinary CI. The ordinary matrix is Node 22 with one uniform PowerShell 7 shell on Ubuntu, macOS, and Windows.

## Conventions

- Documentation follows `docs/DOCS_RULE.md`, the local canonical maintainer guide.
- `README.md` is evergreen, `CHANGELOG.md` owns release history, and the English/Korean pairs remain structurally parallel.
- Version sources are `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `package.json`; the lockfile and MCP bundle are derived checks.
- Read a version portably with `node -e "console.log(require('./.codex-plugin/plugin.json').version)"` or the matching Claude manifest command.
- Capture remains OFF by default, redaction precedes host dispatch and persistence, and new cards remain local until explicit promotion.

## Pull requests

Keep changes focused, include user-observable changelog updates in both languages, and attach the fresh verification output. For security reports, follow [SECURITY.md](SECURITY.md).
