# deep-memory - Codex Project Guide

Cross-project semantic operational memory. The plugin keeps Claude Code slash-command surfaces and exposes Codex-native skills and manifest metadata.

Current version: 0.1.0.

## Runtime Surfaces

- Codex manifest: `.codex-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`
- User-invocable skills: `skills/deep-memory-*/SKILL.md`
- Schema reference: `skills/memory-schema/SKILL.md`
- Sub-agent: `agents/memory-distiller.md`
- Memory root (default): `~/.deep-memory/` (override: env `DEEP_MEMORY_ROOT`)

Keep memory data and runtime locks out of the plugin repo unless they are intentional test fixtures.

## Verification

```bash
node -e "JSON.parse(require('fs').readFileSync('.codex-plugin/plugin.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8'))"
npm test
```

After a release, update both suite marketplace manifests in
`/Users/sungmin/Dev/claude-plugins/deep-suite/`.
