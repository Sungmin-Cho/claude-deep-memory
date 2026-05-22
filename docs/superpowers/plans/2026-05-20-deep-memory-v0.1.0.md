# deep-memory v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deep-suite의 7번째 플러그인 `deep-memory` v0.1.0 (skeleton + harvest + Hybrid distill + brief + audit) 을 Claude Code + Codex 양쪽에서 작동하도록 구현하고, deep-suite marketplace 에 등록한다.

**Architecture:** 4 user-invocable skills + 1 reference skill, Node22+bash scripts/lib, M3 envelope-wrapped artifacts, sqlite FTS5 lexical retrieval, mkdir-based lock + lease + atomic write, 3-pass redaction, cross-runtime LLM adapter bridge.

**Tech Stack:** Node 22 LTS, `better-sqlite3` (with `sql.js` fallback), Ajv (JSON Schema), `node --test` runner, bash 5+, M3 envelope schema (deep-suite/schemas).

**Spec reference:** `/Users/sungmin/Dev/claude-plugins/deep-memory/docs/superpowers/specs/2026-05-20-deep-memory-design.md` (1080+ lines, deep-review-loop 4 round 검증 완료)

**총 phase**: 10 (0/1/2/3a/3b/4/5/6/7/8), **추정**: ~16 영업일 (Round 1 plan-review 반영 — P29 schedule re-estimate, 3a/5 task per-task expand 포함).

**기존 상태**:
- `git init` 완료 (commits: `0637d0f`, `c02365b`, `4e78f87`)
- 기존 트리: `docs/` (proposal + spec + plans/), `.deep-review/` (reports + responses), `.gitignore`

**형제 참조 디렉토리** (반드시 패턴 일치 확인):
- `/Users/sungmin/Dev/claude-plugins/deep-wiki/` — manifest 패턴, skill SKILL.md 구조, hooks 패턴
- `/Users/sungmin/Dev/claude-plugins/deep-docs/` — 가장 단순한 형제 (hooks 없음)
- `/Users/sungmin/Dev/claude-plugins/deep-suite/` — marketplace.json × 2 + suite-extensions.json
- `/Users/sungmin/Dev/claude-plugins/deep-suite/schemas/` — M3 envelope schema 정의

---

## File Structure Decisions

Spec §3의 디렉토리 layout 그대로 따른다. 핵심 결정:
- 모든 lib 파일은 `scripts/lib/` 안에 단일 책임 (envelope / redact / dedupe / state-machine / lock / atomic-write / source-hash / score / preflight / adapter-registry / llm-bridge).
- skill SKILL.md 는 frontmatter (≤1024 char description, strict YAML) + 한국어 본문 (deep-wiki 패턴).
- 모든 test 는 `tests/<topic>.test.js` 또는 `tests/runtime-contract/<adapter>.test.js`.
- 모든 schema 는 `schemas/<artifact>.schema.json` (draft 2020-12).
- agents/ 는 sub-agent 정의 (`memory-distiller.md`).

---

## Phase 0 — Skeleton (0.5일)

목표: 두 manifest, 짧은 CLAUDE.md/AGENTS.md, README × 2, package.json, LICENSE, .gitignore 보강, better-sqlite3 install probe 확인. 첫 commit + suite 등록 가능 상태.

### Task 0.1: Claude Code manifest (`.claude-plugin/plugin.json`)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/.claude-plugin/plugin.json`

- [ ] **Step 1: Create directory**

```bash
mkdir -p /Users/sungmin/Dev/claude-plugins/deep-memory/.claude-plugin
```

- [ ] **Step 2: Write plugin.json**

```json
{
  "name": "deep-memory",
  "version": "0.1.0",
  "description": "Cross-project semantic operational memory — harvests deep-suite artifacts, distills reusable patterns/failures/decisions/experiment outcomes (Hybrid: rule-based + sub-agent LLM), and injects task-specific memory briefs into future work. Skill-based entry surfaces (Claude Code slash + Codex/Copilot CLI/Gemini CLI/SDK via Skill()).",
  "author": { "name": "sungmin" },
  "license": "MIT",
  "keywords": [
    "memory",
    "cross-project",
    "semantic-memory",
    "operational-memory",
    "reasoning-graph",
    "deep-suite"
  ]
}
```

- [ ] **Step 3: Validate JSON syntax**

Run: `node -e "JSON.parse(require('fs').readFileSync('/Users/sungmin/Dev/claude-plugins/deep-memory/.claude-plugin/plugin.json','utf8'))" && echo OK`
Expected: `OK`

### Task 0.2: Codex manifest (`.codex-plugin/plugin.json`)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/.codex-plugin/plugin.json`

- [ ] **Step 1: Create directory and file**

```bash
mkdir -p /Users/sungmin/Dev/claude-plugins/deep-memory/.codex-plugin
```

```json
{
  "name": "deep-memory",
  "version": "0.1.0",
  "description": "Cross-project semantic operational memory",
  "author": { "name": "sungmin" },
  "repository": "https://github.com/Sungmin-Cho/claude-deep-memory.git",
  "license": "MIT",
  "keywords": ["memory", "cross-project", "deep-suite"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Deep Memory",
    "shortDescription": "Cross-project operational memory + reasoning",
    "longDescription": "Harvest deep-suite artifacts, distill reusable memory cards (pattern/failure-case/decision/experiment/style) with hybrid rule+LLM pipeline, and inject task-specific memory briefs.",
    "developerName": "sungmin",
    "category": "Productivity",
    "capabilities": ["Interactive", "Read", "Write"],
    "defaultPrompt": [
      "$deep-memory:deep-memory-init",
      "$deep-memory:deep-memory-harvest",
      "$deep-memory:deep-memory-brief"
    ],
    "brandColor": "#7C3AED",
    "screenshots": []
  }
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('/Users/sungmin/Dev/claude-plugins/deep-memory/.codex-plugin/plugin.json','utf8'))" && echo OK`
Expected: `OK`

### Task 0.3: package.json

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/package.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "deep-memory",
  "version": "0.1.0",
  "description": "Cross-project semantic operational memory — tests + helpers only; plugin manifest at .claude-plugin/plugin.json.",
  "author": { "name": "Sungmin-Cho" },
  "license": "MIT",
  "private": true,
  "category": "Productivity",
  "keywords": ["memory", "cross-project", "deep-suite"],
  "scripts": {
    "test": "node --test tests/",
    "test:envelope": "node --test tests/envelope-emit.test.js",
    "test:redaction": "node --test tests/redaction.test.js",
    "validate-manifest": "node scripts/validate-manifest.js"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "ajv": "^8.17.0",
    "ajv-formats": "^3.0.0"
  },
  "optionalDependencies": {
    "sql.js": "^1.10.0"
  }
}
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('/Users/sungmin/Dev/claude-plugins/deep-memory/package.json','utf8'))" && echo OK`

### Task 0.4: LICENSE (MIT, 형제와 동일)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/LICENSE`

- [ ] **Step 1: Copy MIT LICENSE from deep-wiki**

```bash
cp /Users/sungmin/Dev/claude-plugins/deep-wiki/LICENSE /Users/sungmin/Dev/claude-plugins/deep-memory/LICENSE
```

- [ ] **Step 2: Verify it is MIT and update year/holder if needed**

Run: `head -3 /Users/sungmin/Dev/claude-plugins/deep-memory/LICENSE`
Expected: starts with "MIT License" + current year + "Sungmin-Cho".

### Task 0.5: CLAUDE.md (~2KB)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

```markdown
# deep-memory — Project Guide for Claude

**Auto-loaded for plugin developers running Claude Code in this repo clone** (P24 correction — marketplace-installed users see README + skills entry surfaces). Project overview + drift-resistant structural notes only. Version-by-version notes belong in `CHANGELOG.md`.

## Project Overview

**deep-memory** is the 7th plugin in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace. It harvests artifacts emitted by sibling plugins (`deep-work`, `deep-review`, `deep-evolve`, `deep-docs`, `deep-wiki`, `deep-dashboard`) and distills them into reusable **memory cards** — patterns, failures, architecture decisions, experiment outcomes, coding-style rules — that future work can recall via task-specific memory briefs.

**Three-layer model:**
1. **Events** — raw harvest of sibling plugin artifacts (JSONL append-only)
2. **Cards** — distilled, M3-envelope-wrapped semantic memory (rule-based + sub-agent LLM)
3. **Briefs** — task-specific top-N retrieval (lexical FTS5 + project similarity)

## Cross-runtime surfaces

Skill-based entry — same skills run from Claude Code (`/deep-memory-*`), Codex (`$deep-memory:deep-memory-*`), Copilot CLI, Gemini CLI, Agent SDK (`Skill({skill:"deep-memory:..."})`).

## Directory Structure

```
deep-memory/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── agents/memory-distiller.md          # sub-agent (Read-only)
├── schemas/                             # normative JSON Schema (draft 2020-12)
├── scripts/{harvest,distill,retrieve,audit}.js + lib/
├── skills/{deep-memory-init,deep-memory-harvest,
│          deep-memory-brief,deep-memory-audit,memory-schema}/SKILL.md
└── tests/                               # node --test, with runtime-contract/
```

## MVP Commands

- `/deep-memory-init` — initialize `~/.deep-memory/` + project-profile
- `/deep-memory-harvest` — scan sibling artifacts → events → distill → cards
- `/deep-memory-brief "<task>"` — top-N memory brief for a task
- `/deep-memory-audit [--unlock | --promote <id>]` — schema/stale/lock/promotion audit

## Storage

- **Global**: `~/.deep-memory/` (override: env `DEEP_MEMORY_ROOT`). cards/events/indexes/projects/.leases/.lock.
- **Project-local**: `.deep-memory/` (gitignored). project-profile + latest-harvest/brief/audit.

## 🚨 Cross-repo Update Workflow

Every release: bump version in `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `package.json` (manifest-drift CI checks). Then sync **`/Users/sungmin/Dev/claude-plugins/deep-suite/`** — `marketplace.json` × 2 (sha + description) + `suite-extensions.json` (artifacts/data_flow). Then update CHANGELOG.md + CHANGELOG.ko.md.

## Privacy invariant

3-pass rule-based redaction (Step A input / Step B input / envelope wrap). `privacy_level: local` default — `--promote <id>` is the only path to `global`.

## Pointers

- Spec: `docs/superpowers/specs/2026-05-20-deep-memory-design.md`
- Plan: `docs/superpowers/plans/2026-05-20-deep-memory-v0.1.0.md`
- Handoff (Phase 4-6): `docs/handoff-phase-4-6.md`
- CHANGELOG: `CHANGELOG.md` / `CHANGELOG.ko.md`
```

- [ ] **Step 2: Verify size (P26 — upper bound only)**

Run: `wc -c /Users/sungmin/Dev/claude-plugins/deep-memory/CLAUDE.md`
Expected: `≤ 2500 bytes` (target ~2KB; floor 무의미한 brittle assertion 제거).

### Task 0.6: AGENTS.md (~1KB, Codex entry point)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/AGENTS.md`

- [ ] **Step 1: Write AGENTS.md**

```markdown
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
```

- [ ] **Step 2: Verify size (P26 — upper bound only)**

Run: `wc -c /Users/sungmin/Dev/claude-plugins/deep-memory/AGENTS.md`
Expected: `≤ 1300 bytes`.

### Task 0.7: README.md + README.ko.md (간단 — 형제와 같은 길이)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/README.md`
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/README.ko.md`

- [ ] **Step 1: Write README.md** (영문, 4-5KB 정도)

```markdown
# deep-memory

> Cross-project semantic operational memory for the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite).

Harvests artifacts emitted by sibling deep-suite plugins, distills them into reusable memory cards (Hybrid: rule-based + LLM sub-agent), and surfaces task-specific memory briefs that future work can recall.

## Status

**v0.1.0 MVP** — Phase 0-3 of the [design spec](docs/superpowers/specs/2026-05-20-deep-memory-design.md). Skeleton + harvest + distill + brief + audit. Phase 4-6 (writer integration / reasoning graph / dashboard telemetry) tracked in [`docs/handoff-phase-4-6.md`](docs/handoff-phase-4-6.md).

## Install

Via the `claude-deep-suite` marketplace:

```bash
# Claude Code
/plugin install deep-memory@claude-deep-suite

# Codex
codex plugin install deep-memory
```

Or directly from this repo with `--source url` pointed at the GitHub URL.

## Quick start

```bash
# 1. Initialize memory root (~/.deep-memory/ by default; override with DEEP_MEMORY_ROOT)
/deep-memory-init

# 2. Harvest the current project's sibling-plugin artifacts
/deep-memory-harvest

# 3. Get a memory brief for an upcoming task
/deep-memory-brief "implement Codex-compatible plugin manifest"

# 4. Periodic audit (stale memory, schema drift, lock recovery)
/deep-memory-audit
```

## Three-layer model

1. **Events** — append-only JSONL of raw harvest under `~/.deep-memory/events/YYYY-MM.jsonl`
2. **Cards** — distilled M3-envelope-wrapped semantic memory under `~/.deep-memory/cards/<type>/{global,project_id}/`
3. **Briefs** — top-N retrieval written to `.deep-memory/latest-brief.{json,md}` for the current project

## Skills

| Skill | Purpose |
|---|---|
| `deep-memory-init` | initialize memory root + project profile |
| `deep-memory-harvest` | scan sibling artifacts → distill → persist |
| `deep-memory-brief` | top-N memory brief for a task |
| `deep-memory-audit` | schema/stale/redaction/lock/promote audit |
| `memory-schema` (reference) | M3 envelope + card schema + state machine |

## Privacy

- 3-pass rule-based redaction (Step A input / Step B input / envelope wrap)
- `privacy_level: local` per-card default; `--promote <id>` is the only path to global memory
- `suppressions.yaml` for user-defined deny patterns

## Cross-runtime

Same skills run from Claude Code (slash), Codex (`$deep-memory:...`), Copilot CLI, Gemini CLI, Agent SDK (`Skill({skill:"deep-memory:..."})`). LLM distillation auto-detects the host adapter (claude-agent / codex-bash / gemini-sdk / stdin-fallback).

## Documentation

- [Design spec](docs/superpowers/specs/2026-05-20-deep-memory-design.md)
- [Implementation plan](docs/superpowers/plans/2026-05-20-deep-memory-v0.1.0.md)
- [CHANGELOG](CHANGELOG.md)
- [한국어 README](README.ko.md)

## License

MIT
```

- [ ] **Step 2: Write README.ko.md** — 위 영문 README의 1:1 한국어 미러. 동일 구조, 동일 섹션.

- [ ] **Step 3: Verify sizes (P26 — upper bound only)**

Run: `wc -c /Users/sungmin/Dev/claude-plugins/deep-memory/README.md /Users/sungmin/Dev/claude-plugins/deep-memory/README.ko.md`
Expected: each `≤ 5500 bytes`.

### Task 0.8: CHANGELOG.md + CHANGELOG.ko.md (initial v0.1.0 placeholder)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/CHANGELOG.md`
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/CHANGELOG.ko.md`

- [ ] **Step 1: Write CHANGELOG.md**

```markdown
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
```

- [ ] **Step 2: Write CHANGELOG.ko.md** — 위 영문의 한국어 미러.

### Task 0.9: .gitignore 보강

**Files:**
- Modify: `/Users/sungmin/Dev/claude-plugins/deep-memory/.gitignore`

- [ ] **Step 1: Replace existing .gitignore content**

```
# macOS metadata
.DS_Store

# Node dependencies
node_modules/
package-lock.json

# Project-local runtime state (not part of spec)
.deep-memory/

# Test artifacts
coverage/
*.lcov
.nyc_output/

# Editor
.vscode/
.idea/
*.swp
```

### Task 0.10: better-sqlite3 install probe + sql.js fallback

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/scripts/check-sqlite.js`

- [ ] **Step 0 (P28 — pre-check)**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
test -f package.json || { echo "package.json missing — run Task 0.3 first"; exit 1; }
```

- [ ] **Step 1: Install better-sqlite3 and write probe**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory && npm install
```

```javascript
// scripts/check-sqlite.js
let driver = null;
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES('hello');");
  const r = db.prepare("SELECT * FROM t WHERE t MATCH 'hello'").all();
  if (r.length !== 1) throw new Error('FTS5 sanity check failed');
  db.close();
  driver = 'better-sqlite3';
} catch (e) {
  try {
    require.resolve('sql.js');
    driver = 'sql.js';
  } catch (e2) {
    console.error('No SQLite driver available (better-sqlite3 native build failed AND sql.js not installed).');
    process.exit(1);
  }
}
console.log(driver);
```

- [ ] **Step 2: Run probe**

Run: `node /Users/sungmin/Dev/claude-plugins/deep-memory/scripts/check-sqlite.js`
Expected: `better-sqlite3` (preferred) or `sql.js` (fallback). exit code 0.

### Task 0.11: First commit (Phase 0)

- [ ] **Step 1: Stage and commit**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
git add .claude-plugin/ .codex-plugin/ package.json LICENSE CLAUDE.md AGENTS.md README.md README.ko.md CHANGELOG.md CHANGELOG.ko.md .gitignore scripts/check-sqlite.js
git commit -m "feat(phase-0): skeleton — manifests, package.json, CLAUDE/AGENTS, README × 2, CHANGELOG × 2, install probe

Phase 0 of v0.1.0 implementation plan.
- two manifests (Claude Code minimal + Codex with interface)
- short CLAUDE.md (~2KB) + AGENTS.md (~1KB) per user request
- README/CHANGELOG bilingual (en + ko)
- check-sqlite.js install probe (better-sqlite3 native + sql.js fallback)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 — Schemas + scripts/lib (1.5일)

목표: 4 JSON Schema (normative) + 10 lib 파일 (envelope / redact / dedupe / state-machine / lock / atomic-write / source-hash / score / preflight / adapter-registry). 각 lib 마다 단위 테스트 1개씩.

### Task 1.0a (NEW, P11): Verify suite M3 envelope schema compatibility before extending source_artifacts

**Files** (READ-ONLY):
- `/Users/sungmin/Dev/claude-plugins/deep-suite/schemas/artifact-envelope.schema.json`

- [ ] **Step 1: Read suite envelope schema + check `provenance.source_artifacts[]` extensibility**

```bash
node -e "
const s = JSON.parse(require('fs').readFileSync('/Users/sungmin/Dev/claude-plugins/deep-suite/schemas/artifact-envelope.schema.json','utf8'));
const sa = s.properties?.envelope?.properties?.provenance?.properties?.source_artifacts?.items;
console.log('additionalProperties:', sa?.additionalProperties);
console.log('allowed keys:', Object.keys(sa?.properties || {}));
"
```

- [ ] **Step 2: Decision tree**
  - If `additionalProperties: true` (or omitted) → extra fields (`id`, `content_hash`, `captured_at`, `artifact_kind`, `schema_version`) are accepted as-is. Proceed to Task 1.1.
  - If `additionalProperties: false` → either (a) add a PR to suite repo extending the schema (requires sibling repo coordination), OR (b) move extra fields into `payload.deep_memory_provenance` (deep-memory-specific, not validated by suite sibling). For MVP, **option (b) is safer** — keeps suite schema compat 100%. Plan Task 1.1 / 1.3 / 6.x adjusts.
  - **Document decision in spec §6 + commit message.**

- [ ] **Step 3: Write decision document + commit** (R3 ℹ️ fix — git history readable in future)

```bash
mkdir -p /Users/sungmin/Dev/claude-plugins/deep-memory/.deep-review/decisions
```

Create `/Users/sungmin/Dev/claude-plugins/deep-memory/.deep-review/decisions/2026-05-20-envelope-compat.md`:

```markdown
# Decision — suite M3 envelope compat (Task 1.0a)

Probe result: <option (a) suite accepts extra props | option (b) suite has additionalProperties:false>
Decision: <chosen option>
Affects: Task 1.1 (schema) + 2.4 (source_artifacts shape) + 3a.* (mapper output) + 4.6 (cross-ref test)
Date: 2026-05-20
```

Then commit:

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
git add .deep-review/decisions/2026-05-20-envelope-compat.md
git commit -m "decision(phase-1): suite envelope compat — option <a|b> per Task 1.0a probe"
```

### Task 1.1: `schemas/memory-card.schema.json` (normative — branches on Task 1.0a result, R3 P11 fix)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/schemas/memory-card.schema.json`

- [ ] **Step 1: Write schema — explicit branching by Task 1.0a outcome**:

  - **Option (a)** — suite envelope schema accepts additional properties: include `id / content_hash / captured_at / artifact_kind / schema_version` in `envelope.provenance.source_artifacts[].properties` as REQUIRED. (the schema shown below uses this option as the default — only swap if Task 1.0a probe returned option (b))
  - **Option (b)** — suite envelope schema has `additionalProperties: false`: keep `envelope.provenance.source_artifacts[]` minimal (`path`, `run_id` only); move deep-memory specific fields into a new `payload.deep_memory_provenance: [{id, content_hash, captured_at, artifact_kind, schema_version, source_index}]` array, where `source_index` maps to the envelope's `source_artifacts[index]`. Adjust all subsequent task references (Task 2.4 / 3a.x / 4.6) to use `payload.deep_memory_provenance` instead of `envelope.provenance.source_artifacts[].id`.

  Task 1.0a Step 3 의 commit message 가 어느 option 인지 기록.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Sungmin-Cho/claude-deep-memory/schemas/memory-card.schema.json",
  "title": "Memory Card",
  "type": "object",
  "required": ["schema_version", "envelope", "payload"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "const": "1.0" },
    "envelope": {
      "type": "object",
      "required": ["producer", "producer_version", "artifact_kind", "run_id", "generated_at", "schema", "git", "provenance"],
      "properties": {
        "producer": { "const": "deep-memory" },
        "producer_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
        "artifact_kind": { "const": "memory-card" },
        "run_id": { "type": "string", "minLength": 1 },
        "generated_at": { "type": "string", "format": "date-time" },
        "schema": {
          "type": "object",
          "required": ["name", "version"],
          "properties": {
            "name": { "const": "memory-card" },
            "version": { "type": "string" }
          }
        },
        "git": {
          "type": "object",
          "properties": {
            "head": { "type": "string" },
            "branch": { "type": "string" },
            "dirty": { "type": "string" }
          }
        },
        "provenance": {
          "type": "object",
          "required": ["source_artifacts"],
          "properties": {
            "source_artifacts": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["id", "path", "content_hash", "captured_at", "artifact_kind", "schema_version"],
                "properties": {
                  "id": { "type": "string", "pattern": "^src_\\d+$" },
                  "path": { "type": "string" },
                  "content_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]+$" },
                  "captured_at": { "type": "string", "format": "date-time" },
                  "artifact_kind": { "type": "string" },
                  "schema_version": { "type": "string" },
                  "run_id": { "type": "string" }
                }
              }
            },
            "tool_versions": { "type": "object" }
          }
        }
      }
    },
    "payload": {
      "type": "object",
      "required": [
        "memory_id", "memory_type", "dedupe_key", "privacy_level",
        "title", "claim", "evidence_summary", "applicability",
        "non_applicability", "recommended_action", "search_keywords",
        "confidence", "status", "status_history", "tags",
        "created_at", "last_seen_at", "review_after", "feedback"
      ],
      "additionalProperties": false,
      "properties": {
        "memory_id": { "type": "string", "pattern": "^mem_[a-z_]+_[a-f0-9]+$" },
        "memory_type": { "enum": ["pattern", "failure-case", "architecture-decision", "experiment-outcome", "coding-style"] },
        "dedupe_key": { "type": "string", "pattern": "^sha256:[a-f0-9]{64}$" },
        "privacy_level": { "enum": ["local", "global"], "default": "local" },
        "title": { "type": "string", "minLength": 1, "maxLength": 200 },
        "claim": { "type": "string", "minLength": 1, "maxLength": 600 },
        "evidence_summary": {
          "type": "array",
          "minItems": 0,
          "maxItems": 5,
          "items": { "type": "string", "minLength": 1, "maxLength": 200 }
        },
        "applicability": {
          "type": "array",
          "minItems": 0,
          "items": {
            "type": "object",
            "required": ["value", "source_id", "confidence"],
            "properties": {
              "value": { "type": "string", "minLength": 1 },
              "source_id": { "type": "string", "pattern": "^src_\\d+$" },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
            }
          }
        },
        "non_applicability": { "$ref": "#/properties/payload/properties/applicability" },
        "recommended_action": {
          "type": "array",
          "minItems": 0,
          "items": { "type": "string" }
        },
        "search_keywords": {
          "type": "array",
          "minItems": 0,
          "maxItems": 15,
          "items": { "type": "string", "minLength": 1, "maxLength": 40 }
        },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "status": { "enum": ["candidate", "validated", "contradicted", "deprecated"] },
        "status_history": {
          "type": "array",
          "minItems": 0,
          "maxItems": 10,
          "items": {
            "type": "object",
            "required": ["from", "to", "at", "by"],
            "properties": {
              "from": { "type": "string" },
              "to": { "type": "string" },
              "at": { "type": "string", "format": "date-time" },
              "by": { "type": "string" }
            }
          }
        },
        "tags": { "type": "array", "items": { "type": "string" } },
        "created_at": { "type": "string", "format": "date-time" },
        "last_seen_at": { "type": "string", "format": "date-time" },
        "review_after": { "type": "string", "format": "date-time" },
        "feedback": {
          "type": "object",
          "required": ["accepted_count", "rejected_count", "inaccurate_count"],
          "properties": {
            "accepted_count": { "type": "integer", "minimum": 0 },
            "rejected_count": { "type": "integer", "minimum": 0 },
            "inaccurate_count": { "type": "integer", "minimum": 0 }
          }
        },
        "redaction_metadata": {
          "type": "object",
          "properties": {
            "rules_matched": { "type": "integer", "minimum": 0 },
            "chars_masked": { "type": "integer", "minimum": 0 },
            "preview": { "type": "string" }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Validate schema against Ajv meta-schema**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
node -e "
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats').default;
const ajv = new Ajv({strict: true});
addFormats(ajv);
const schema = JSON.parse(require('fs').readFileSync('schemas/memory-card.schema.json', 'utf8'));
ajv.compile(schema);
console.log('OK');
"
```
Expected: `OK`

### Task 1.2: `schemas/memory-event.schema.json` + `project-profile.schema.json` + `memory-card-distill-output.schema.json`

**Files:**
- Create: `schemas/memory-event.schema.json`
- Create: `schemas/project-profile.schema.json`
- Create: `schemas/memory-card-distill-output.schema.json`

- [ ] **Step 1: Write memory-event schema** (envelope wrapped event-draft, similar shape but `artifact_kind: memory-event`, payload has `event_key`, `source_artifact_id`, `event_kind: "harvested" | "merged" | "promoted" | "demoted"`).

- [ ] **Step 2: Write project-profile schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Sungmin-Cho/claude-deep-memory/schemas/project-profile.schema.json",
  "title": "Project Profile",
  "type": "object",
  "required": ["project_id", "repo", "signature", "suite", "privacy", "generated_at"],
  "additionalProperties": false,
  "properties": {
    "project_id": { "type": "string", "pattern": "^proj_[a-f0-9]+$" },
    "repo": {
      "type": "object",
      "required": ["remote_url_hash", "root_path_hash", "default_branch"],
      "properties": {
        "remote_url_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]+$" },
        "root_path_hash": { "type": "string", "pattern": "^sha256:[a-f0-9]+$" },
        "default_branch": { "type": "string" },
        "git_head": { "type": "string" }
      }
    },
    "signature": {
      "type": "object",
      "properties": {
        "languages": { "type": "array", "items": { "type": "string" } },
        "runtimes": { "type": "array", "items": { "type": "string" } },
        "topology": { "type": "string" },
        "test_frameworks": { "type": "array", "items": { "type": "string" } },
        "package_managers": { "type": "array", "items": { "type": "string" } },
        "agent_runtime": { "type": "array", "items": { "type": "string" } }
      }
    },
    "suite": {
      "type": "object",
      "properties": {
        "installed_plugins": { "type": "array", "items": { "type": "string" } }
      }
    },
    "privacy": {
      "type": "object",
      "required": ["scope", "allow_export"],
      "properties": {
        "scope": { "enum": ["local", "team", "org"] },
        "allow_export": { "type": "boolean" }
      }
    },
    "source_mtimes": { "type": "object" },
    "generated_at": { "type": "string", "format": "date-time" }
  }
}
```

- [ ] **Step 3: Write memory-card-distill-output schema** (Step B sub-agent 출력 형식 — payload 의 subset, LLM-fillable fields 만)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/Sungmin-Cho/claude-deep-memory/schemas/memory-card-distill-output.schema.json",
  "title": "Memory Card Distill Output (Step B sub-agent response)",
  "type": "object",
  "required": ["claim_refined", "non_applicability", "recommended_action", "search_keywords"],
  "additionalProperties": false,
  "properties": {
    "claim_refined": { "type": "string", "minLength": 1, "maxLength": 600 },
    "non_applicability": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["value", "confidence"],
        "properties": {
          "value": { "type": "string", "minLength": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    },
    "recommended_action": {
      "type": "array",
      "items": { "type": "string" }
    },
    "search_keywords": {
      "type": "array",
      "maxItems": 15,
      "items": { "type": "string", "minLength": 1, "maxLength": 40 }
    }
  }
}
```

- [ ] **Step 4: Validate all three schemas with Ajv (loop the file list)**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
for f in schemas/*.schema.json; do
  node -e "
  const Ajv = require('ajv/dist/2020'); const addFormats = require('ajv-formats').default;
  const ajv = new Ajv({strict: true}); addFormats(ajv);
  ajv.compile(JSON.parse(require('fs').readFileSync('$f','utf8')));
  console.log('$f OK');
  "
done
```
Expected: 4 `OK` lines.

### Task 1.3: `scripts/lib/envelope.js` — M3 envelope wrap

**Files:**
- Create: `scripts/lib/envelope.js`
- Test: `tests/envelope-emit.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/envelope-emit.test.js (P10 fix — regex matches `_` separator emitted by ulidLike)
const test = require('node:test');
const assert = require('node:assert');
const { wrap } = require('../scripts/lib/envelope');

test('envelope.wrap embeds producer + run_id + payload', () => {
  const out = wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload: { hello: 'world' },
  });
  assert.strictEqual(out.envelope.producer, 'deep-memory');
  assert.match(out.envelope.run_id, /^[a-z0-9_]+$/); // P10: `_` allowed (ulidLike uses underscore separator)
  assert.match(out.envelope.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepStrictEqual(out.payload, { hello: 'world' });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test tests/envelope-emit.test.js`
Expected: FAIL (`Cannot find module '../scripts/lib/envelope'`).

- [ ] **Step 3: Write minimal envelope.js**

```javascript
// scripts/lib/envelope.js
'use strict';
const { randomBytes } = require('crypto');
const { execSync } = require('child_process');

const PRODUCER = 'deep-memory';
const PRODUCER_VERSION = require('../../package.json').version;

function ulidLike() {
  return Date.now().toString(36) + '_' + randomBytes(8).toString('hex');
}

function gitStateSafe() {
  try {
    const head = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0 ? 'true' : 'false';
    return { head, branch, dirty };
  } catch {
    return { head: 'unknown', branch: 'unknown', dirty: 'unknown' };
  }
}

function wrap({ artifact_kind, schema, payload, provenance = { source_artifacts: [] } }) {
  return {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope: {
      producer: PRODUCER,
      producer_version: PRODUCER_VERSION,
      artifact_kind,
      run_id: ulidLike(),
      generated_at: new Date().toISOString(),
      schema,
      git: gitStateSafe(),
      provenance: {
        source_artifacts: provenance.source_artifacts || [],
        tool_versions: { node: process.version, ...(provenance.tool_versions || {}) },
      },
    },
    payload,
  };
}

module.exports = { wrap, ulidLike };
```

- [ ] **Step 4: Run, expect PASS**

Run: `node --test tests/envelope-emit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/envelope.js tests/envelope-emit.test.js
git commit -m "feat(phase-1): scripts/lib/envelope.js + emit test (M3 wrap)"
```

### Task 1.4: `scripts/lib/redact.js` — 3-pass redaction

**Files:**
- Create: `scripts/lib/redact.js`
- Test: `tests/redaction.test.js`
- Create: `tests/fixtures/dangerous-secrets.json`

- [ ] **Step 1: Write known-secret fixture**

```json
{
  "samples": [
    "api_key=sk-1234567890abcdefghijklmnop",
    "token: Bearer abcdef1234567890ABCDEF1234567890",
    "user@example.com",
    "postgres://admin:hunter2@db.internal:5432/prod",
    "/Users/sungmin/secret/file.txt",
    "10.0.42.17",
    "acme-internal.dev",
    "DB_PASSWORD=zXc9yT1m4QrPlOk2BvDsEf3GhAa6"
  ]
}
```

- [ ] **Step 2: Write failing test**

```javascript
// tests/redaction.test.js
const test = require('node:test');
const assert = require('node:assert');
const { redactString, redactObject, REDACT_TAG } = require('../scripts/lib/redact');
const fixture = require('./fixtures/dangerous-secrets.json');

test('redactString masks all known secret patterns', () => {
  for (const sample of fixture.samples) {
    const out = redactString(sample);
    assert.ok(out.includes(REDACT_TAG), `pattern not masked: ${sample}`);
  }
});

test('redactObject recurses into nested arrays/objects', () => {
  const input = { a: 'api_key=sk-abcdefghijklmnopqrstuvwx', b: ['user@example.com', { c: '/Users/x/y' }] };
  const out = redactObject(input);
  assert.ok(JSON.stringify(out).includes(REDACT_TAG));
  assert.ok(!JSON.stringify(out).includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('redactString respects suppressions allow_patterns', () => {
  const input = 'SQL_INJECTION_TEST_TAG=please_keep';
  const out = redactString(input, { allowPatterns: ['SQL_INJECTION_TEST_TAG'] });
  assert.ok(out.includes('SQL_INJECTION_TEST_TAG'));
});
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Write minimal redact.js**

```javascript
// scripts/lib/redact.js
'use strict';
const os = require('os');

const REDACT_TAG = '[REDACTED]';

const DENY_PATTERNS = [
  /(?:api[_-]?key|token|secret|bearer|password|passwd|pwd)[\s:=]+["']?[A-Za-z0-9_\-+/]{12,}/gi,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b(?:postgres|mysql|mongodb|redis|amqp)(?:ql)?:\/\/[^\s'"<>]+/gi,
  /\b10\.\d+\.\d+\.\d+\b/g,
  /\b192\.168\.\d+\.\d+\b/g,
  /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/g,
  /\b[A-Za-z0-9_-]+\.(?:internal|local|lan)\b/gi,
];

const HOME_RE = new RegExp(os.homedir().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');

function redactString(input, { allowPatterns = [] } = {}) {
  if (typeof input !== 'string') return input;
  let out = input.replace(HOME_RE, '~');
  for (const re of DENY_PATTERNS) {
    out = out.replace(re, REDACT_TAG);
  }
  for (const allow of allowPatterns) {
    const allowRe = new RegExp(allow, 'g');
    if (allowRe.test(input)) {
      const masked = input.match(allowRe) || [];
      for (const m of masked) {
        out = out.replace(REDACT_TAG, m); // 첫 매치만 복원 — false-positive 보정
      }
    }
  }
  return out;
}

function redactObject(value, opts = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, opts));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactObject(value[k], opts);
    return out;
  }
  return value;
}

module.exports = { redactString, redactObject, REDACT_TAG, DENY_PATTERNS };
```

- [ ] **Step 5: Run, expect PASS**
- [ ] **Step 6: Commit**

```bash
git add scripts/lib/redact.js tests/redaction.test.js tests/fixtures/dangerous-secrets.json
git commit -m "feat(phase-1): scripts/lib/redact.js + 3-pass primitives + known-secret invariant test"
```

### Task 1.5: `scripts/lib/dedupe.js` — normalize + dedupe_key

**Files:**
- Create: `scripts/lib/dedupe.js`
- Test: `tests/dedupe.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/dedupe.test.js
const test = require('node:test');
const assert = require('node:assert');
const { normalize, dedupeKey, applicabilitySeedHash } = require('../scripts/lib/dedupe');

test('normalize lowercases, collapses ws, alphanumeric-only', () => {
  assert.strictEqual(normalize('  Use A FOR B!! '), 'use a for b');
});

test('normalize keeps stop-words (보수화 — F15)', () => {
  // "use A for B" vs "use A to B" must remain different
  assert.notStrictEqual(normalize('use A for B'), normalize('use A to B'));
});

test('dedupeKey hashes type + normalized claim + applicability seed', () => {
  const k1 = dedupeKey('failure-case', 'Same claim', [{ value: 'typescript' }]);
  const k2 = dedupeKey('failure-case', 'Same claim', [{ value: 'python' }]);
  assert.notStrictEqual(k1, k2, 'different applicability seed should produce different key');
});

test('cross-type isolation: same normalized claim, different memory_type → different key (F22)', () => {
  const k1 = dedupeKey('failure-case', 'identical text', []);
  const k2 = dedupeKey('pattern', 'identical text', []);
  assert.notStrictEqual(k1, k2);
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```javascript
// scripts/lib/dedupe.js
'use strict';
const { createHash } = require('crypto');

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applicabilitySeedHash(applicability = []) {
  if (!applicability.length) return '';
  const seed = applicability
    .map((a) => (typeof a === 'string' ? a : a.value))
    .filter(Boolean)
    .map((s) => s.toLowerCase().trim())
    .sort()
    .join('|');
  return createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

function dedupeKey(memoryType, claim, applicability = []) {
  const norm = normalize(claim);
  const seed = applicabilitySeedHash(applicability);
  const input = `${memoryType}|${norm}|${seed}`;
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

module.exports = { normalize, dedupeKey, applicabilitySeedHash };
```

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**

```bash
git add scripts/lib/dedupe.js tests/dedupe.test.js
git commit -m "feat(phase-1): scripts/lib/dedupe.js + cross-type + applicability seed test (F15, F22)"
```

### Task 1.6: `scripts/lib/state-machine.js` — 4 자동 + 1 수동 전이

**Files:**
- Create: `scripts/lib/state-machine.js`
- Test: `tests/state-machine.test.js`

- [ ] **Step 1: Write test (covers 4 auto transitions + retention cap)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { evaluateTransitions, MAX_HISTORY } = require('../scripts/lib/state-machine');

test('candidate → validated when evidence>=2 and no contradicting', () => {
  const card = { status: 'candidate', payload: { evidence_summary: ['a', 'b'] }, contradicting: 0 };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'validated');
});

test('candidate → contradicted when contradicting>=1', () => {
  const card = { status: 'candidate', payload: { evidence_summary: ['a'] }, contradicting: 1 };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'contradicted');
});

test('validated → deprecated when review_after past', () => {
  const past = new Date(Date.now() - 86400 * 1000).toISOString();
  const card = { status: 'validated', payload: { review_after: past, evidence_summary: ['a', 'b'] }, contradicting: 0 };
  const t = evaluateTransitions(card);
  assert.strictEqual(t.next, 'deprecated');
});

test('status_history caps at MAX_HISTORY (10)', () => {
  const history = Array(MAX_HISTORY + 5).fill().map((_, i) => ({ from: 'a', to: 'b', at: '2026-01-01T00:00:00Z', by: `auto:${i}` }));
  const card = { status: 'validated', payload: { status_history: history } };
  const out = evaluateTransitions(card, { trimHistory: true });
  assert.strictEqual(out.trimmed.length, MAX_HISTORY);
});
```

- [ ] **Step 2-4: Implement (interface above), run test, commit**

```javascript
// scripts/lib/state-machine.js
'use strict';
const MAX_HISTORY = 10;

function evaluateTransitions(card, { trimHistory = false } = {}) {
  const status = card.status;
  const evidence = (card.payload?.evidence_summary || []).length;
  const contradicting = card.contradicting || 0;
  let next = status;
  let by = null;

  if (status === 'candidate') {
    if (contradicting >= 1) { next = 'contradicted'; by = 'auto:contradicting>=1'; }
    else if (evidence >= 2) { next = 'validated'; by = 'auto:evidence>=2'; }
  } else if (status === 'validated') {
    if (contradicting >= 1) { next = 'contradicted'; by = 'auto:contradicting>=1'; }
    else if (card.payload?.review_after && new Date(card.payload.review_after) < new Date()) {
      next = 'deprecated'; by = 'auto:review_after_past';
    }
  } else if (status === 'contradicted') {
    if ((card.supporting || 0) >= 2) { next = 'candidate'; by = 'auto:new_supporting>=2'; }
  }

  let trimmed = card.payload?.status_history || [];
  if (trimHistory && trimmed.length > MAX_HISTORY) {
    trimmed = trimmed.slice(-MAX_HISTORY);
  }

  return { current: status, next, transitioned: next !== status, by, trimmed };
}

module.exports = { evaluateTransitions, MAX_HISTORY };
```

```bash
git add scripts/lib/state-machine.js tests/state-machine.test.js
git commit -m "feat(phase-1): scripts/lib/state-machine.js + auto transitions + 10-entry retention"
```

### Task 1.7: `scripts/lib/lock.js` — Node mkdir lock + stale detect

**Files:**
- Create: `scripts/lib/lock.js`
- Test: `tests/lock.test.js`

- [ ] **Step 1: Test (covers acquire/release/stale)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { acquire, release, isStale, breakLock, STALE_MS } = require('../scripts/lib/lock');

test('acquire creates lock dir + metadata, release removes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-'));
  const lockPath = path.join(dir, '.lock');
  const handle = await acquire(lockPath, { operation: 'test' });
  assert.ok(fs.existsSync(lockPath));
  const meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.operation, 'test');
  assert.strictEqual(typeof meta.pid, 'number');
  release(handle);
  assert.ok(!fs.existsSync(lockPath));
  fs.rmSync(dir, { recursive: true });
});

test('isStale detects locks older than STALE_MS', () => {
  const meta = { pid: 1, host: 'x', created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(), operation: 'test' };
  assert.strictEqual(isStale(meta), true);
});
```

- [ ] **Step 2-4: Implement + run + commit**

```javascript
// scripts/lib/lock.js (P9 fix — typed STALE_LOCK propagates instead of being swallowed)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STALE_MS = 5 * 60 * 1000;
const BACKOFF_MS = 50;
const MAX_RETRIES = 60;

class StaleLockError extends Error {
  constructor(lockPath, meta) {
    super(`Stale lock detected: ${lockPath} (created_at=${meta.created_at}, pid=${meta.pid}). Run /deep-memory-audit --unlock to break.`);
    this.code = 'STALE_LOCK';
    this.lockPath = lockPath;
    this.meta = meta;
  }
}

async function acquire(lockPath, { operation = 'unknown' } = {}) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      fs.mkdirSync(lockPath);
      const metaPath = path.join(lockPath, 'metadata.json');
      fs.writeFileSync(metaPath, JSON.stringify({
        pid: process.pid, host: os.hostname(),
        created_at: new Date().toISOString(),
        operation,
      }, null, 2));
      return { lockPath, metaPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // P9: only swallow JSON parse / ENOENT during metadata read; propagate StaleLockError
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(lockPath, 'metadata.json'), 'utf8'));
      } catch (readErr) {
        // malformed or transiently missing metadata — fall through to backoff retry
      }
      if (meta && isStale(meta)) {
        throw new StaleLockError(lockPath, meta);  // propagates with typed code; outer catch must not swallow
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
  throw new Error(`Could not acquire lock at ${lockPath} after ${MAX_RETRIES * BACKOFF_MS}ms`);
}

function release(handle) {
  if (!handle) return;
  try { fs.rmSync(handle.lockPath, { recursive: true, force: true }); }
  catch (e) { /* best-effort */ }
}

function isStale(meta) {
  const created = new Date(meta.created_at).getTime();
  return (Date.now() - created) > STALE_MS;
}

function breakLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true });
}

module.exports = { acquire, release, isStale, breakLock, StaleLockError, STALE_MS, BACKOFF_MS };
```

```bash
git add scripts/lib/lock.js tests/lock.test.js
git commit -m "feat(phase-1): scripts/lib/lock.js + stale detect + Node-only (Windows portable)"
```

### Task 1.8: `scripts/lib/atomic-write.js` — temp+fsync+rename

**Files:**
- Create: `scripts/lib/atomic-write.js`
- Test: `tests/atomic-write.test.js`

- [ ] **Step 1: Test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJsonAtomic } = require('../scripts/lib/atomic-write');

test('writeJsonAtomic writes file readable as JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-atomic-'));
  const target = path.join(dir, 'card.json');
  writeJsonAtomic(target, { hello: 'world' });
  const r = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.deepStrictEqual(r, { hello: 'world' });
  // no .tmp leftover
  assert.ok(!fs.existsSync(target + '.tmp'));
  fs.rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2-4: Implement + test + commit**

```javascript
// scripts/lib/atomic-write.js (P8 fix — parent dir fsync AFTER rename, not before)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(target, data) {
  const tmp = target + '.tmp';
  // 1. write + fsync the temp file (file contents durable)
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // 2. atomic rename (POSIX guarantee)
  fs.renameSync(tmp, target);
  // 3. P8: fsync parent dir AFTER rename so the rename result is durable
  const dirFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  // 4. readback validate (sanity)
  try { JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (e) {
    const quarantine = target + '.corrupt-' + Date.now();
    fs.renameSync(target, quarantine);
    throw new Error(`atomic write readback failed; quarantined to ${quarantine}: ${e.message}`);
  }
}

module.exports = { writeJsonAtomic };
```

```bash
git add scripts/lib/atomic-write.js tests/atomic-write.test.js
git commit -m "feat(phase-1): scripts/lib/atomic-write.js + readback validate"
```

### Task 1.9: `scripts/lib/source-hash.js` — content_hash for source artifacts

**Files:**
- Create: `scripts/lib/source-hash.js`
- Test: `tests/source-hash.test.js`

- [ ] **Step 1: Test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { hashFile, hashContent } = require('../scripts/lib/source-hash');

test('hashFile returns sha256: prefixed hex for content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-sh-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'hello world');
  const h = hashFile(file);
  assert.match(h, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(h, hashContent('hello world'));
  fs.rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2-4: Implement + test + commit**

```javascript
// scripts/lib/source-hash.js
'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');

function hashContent(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

function hashFile(filepath) {
  return hashContent(fs.readFileSync(filepath));
}

module.exports = { hashContent, hashFile };
```

```bash
git add scripts/lib/source-hash.js tests/source-hash.test.js
git commit -m "feat(phase-1): scripts/lib/source-hash.js + sha256: prefix invariant"
```

### Task 1.10: `scripts/lib/score.js` — 0-1 정규화 ranking

**Files:**
- Create: `scripts/lib/score.js`
- Test: `tests/score-normalization.test.js`

- [ ] **Step 1: Test (zero/all-stale/missing-profile + clamp invariants)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { bm25MinMax, sigmoid, stalePenalty, scoreCard } = require('../scripts/lib/score');

test('bm25MinMax single result returns 1.0', () => {
  const r = bm25MinMax([{ bm25: 12.3 }]);
  assert.strictEqual(r[0].task_sim_norm, 1.0);
});

test('bm25MinMax multi-result inverts (P13 — smaller raw bm25 = better match)', () => {
  // R3 fix: SQLite FTS5 bm25() smaller=better. Assertions match the INVERTED normalization.
  const r = bm25MinMax([{ bm25: 1 }, { bm25: 5 }, { bm25: 9 }]);
  assert.strictEqual(r[0].task_sim_norm, 1.0);  // raw=1 (best) → norm=1.0
  assert.strictEqual(r[2].task_sim_norm, 0.0);  // raw=9 (worst) → norm=0.0
});

test('sigmoid clamps to (0,1)', () => {
  assert.ok(sigmoid(-100) > 0 && sigmoid(-100) < 0.01);
  assert.ok(sigmoid(100) > 0.99 && sigmoid(100) < 1);
});

test('stalePenalty clamps to [0,1]', () => {
  const future = new Date(Date.now() + 86400 * 1000).toISOString();
  assert.strictEqual(stalePenalty(future, 90), 0);
  const veryOld = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
  assert.strictEqual(stalePenalty(veryOld, 90), 1);
});

test('scoreCard with missing profile forces w_project_sim=0', () => {
  const s = scoreCard({ confidence: 0.8, evidence_count: 2, feedback: { accepted: 0, rejected: 0 }, review_after: null, task_sim_norm: 0.5 }, { project_profile: null });
  assert.ok(s.score >= 0 && s.score <= 1);
});
```

- [ ] **Step 2-4: Implement + test + commit**

```javascript
// scripts/lib/score.js (P13 fix — SQLite FTS5 bm25() returns lower=better; INVERT normalization)
'use strict';

function bm25MinMax(rows) {
  if (!rows.length) return rows;
  if (rows.length === 1) return [{ ...rows[0], task_sim_norm: 1.0 }];
  const vals = rows.map((r) => r.bm25);
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return rows.map((r) => ({ ...r, task_sim_norm: 1.0 }));
  // P13: SQLite FTS5 bm25() returns negative-log-likelihood — SMALLER values = better match.
  // Therefore min-max should map MIN raw bm25 to 1.0 (best) and MAX raw bm25 to 0.0 (worst).
  return rows.map((r) => ({ ...r, task_sim_norm: (max - r.bm25) / (max - min) }));
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function stalePenalty(reviewAfter, graceDays) {
  if (!reviewAfter) return 0;
  const ageMs = Date.now() - new Date(reviewAfter).getTime();
  const graceMs = graceDays * 86400 * 1000;
  return Math.max(0, Math.min(1, ageMs / graceMs));
}

function jaccard(a = [], b = []) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size || 1;
  return inter / uni;
}

function scoreCard(card, { project_profile = null, weights = { w_project_sim: 0.2, w_task_sim: 0.5, w_evidence: 0.3, w_stale_penalty: 0.1 }, audit = { stale_grace_days: 90 } } = {}) {
  let w = { ...weights };
  let project_sim_norm = 0;
  if (!project_profile) w.w_project_sim = 0;
  else {
    project_sim_norm = jaccard(project_profile.signature?.languages || [], card.project_languages || []);
  }
  const evidence_q = (card.confidence || 0) * Math.log(1 + (card.evidence_count || 0)) * (1 - (card.feedback?.rejected || 0) / ((card.feedback?.accepted || 0) + (card.feedback?.rejected || 0) + 1));
  const evidence_norm = sigmoid(evidence_q - 1.5);
  const stale_norm = stalePenalty(card.review_after, audit.stale_grace_days);

  const score = w.w_project_sim * project_sim_norm
              + w.w_task_sim * (card.task_sim_norm || 0)
              + w.w_evidence * evidence_norm
              - w.w_stale_penalty * stale_norm;

  return { score: Math.max(0, Math.min(1, score)), parts: { project_sim_norm, task_sim_norm: card.task_sim_norm || 0, evidence_norm, stale_norm } };
}

module.exports = { bm25MinMax, sigmoid, stalePenalty, jaccard, scoreCard };
```

```bash
git add scripts/lib/score.js tests/score-normalization.test.js
git commit -m "feat(phase-1): scripts/lib/score.js + 0-1 normalization + degraded paths"
```

### Task 1.11: `scripts/lib/preflight.js` — realpath/writability/NFS/sqlite probe

**Files:**
- Create: `scripts/lib/preflight.js`
- Test: extended in Phase 2 (init test)

- [ ] **Step 1: Implement**

```javascript
// scripts/lib/preflight.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function preflight(memoryRoot, { allowNetworkRoot = false } = {}) {
  const result = { ok: true, warnings: [], errors: [], resolved: null, network: false, readOnly: false };
  // realpath
  fs.mkdirSync(memoryRoot, { recursive: true });
  result.resolved = fs.realpathSync(memoryRoot);
  // writability + fsync
  const probe = path.join(result.resolved, '.preflight-' + Date.now());
  try {
    const fd = fs.openSync(probe, 'w');
    fs.writeSync(fd, 'ok');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  } catch (e) {
    result.readOnly = true;
    result.warnings.push(`memory_root read-only: ${e.message}. brief-only mode.`);
  }
  // network mount heuristic
  if (/^\/Volumes\//.test(result.resolved) || /^\/mnt\//.test(result.resolved) || /^\/net\//.test(result.resolved)) {
    result.network = true;
    if (!allowNetworkRoot) {
      result.ok = false;
      result.errors.push(`memory_root looks like network mount (${result.resolved}). Pass --allow-network-root to override.`);
    } else {
      result.warnings.push(`memory_root on network mount: ${result.resolved} (allowed by --allow-network-root).`);
    }
  }
  return result;
}

module.exports = { preflight };
```

- [ ] **Step 2: Commit**

```bash
git add scripts/lib/preflight.js
git commit -m "feat(phase-1): scripts/lib/preflight.js (init test in Phase 2)"
```

### Task 1.12: `scripts/lib/adapter-registry.js` + `llm-bridge.js` — cross-runtime LLM adapter

**Files:**
- Create: `scripts/lib/adapter-registry.js`
- Create: `scripts/lib/llm-bridge.js`
- (Tests: Phase 3b runtime-contract)

- [ ] **Step 1: Implement adapter-registry**

```javascript
// scripts/lib/adapter-registry.js
'use strict';
const { execSync } = require('node:child_process');

function detect(adapter = 'auto') {
  if (adapter !== 'auto') return adapter;
  // Claude Code: CLAUDE_PLUGIN_ROOT env set + node Agent tool reachable via process.send signal is sketch — we just detect env vars.
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude-agent';
  if (process.env.CODEX_PLUGIN_ROOT || hasCmd('codex')) return 'codex-bash';
  if (process.env.GEMINI_API_KEY) return 'gemini-sdk';
  return 'stdin-fallback';
}

function hasCmd(name) {
  try { execSync(`command -v ${name}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

module.exports = { detect };
```

- [ ] **Step 2: Implement llm-bridge (just dispatch — actual adapters in Phase 3b)**

```javascript
// scripts/lib/llm-bridge.js (Phase 1 skeleton — Phase 3b will add schema validation + allowlist)
// P15: from Phase 1, pass through adapterOpts so adapters can receive recordedFixture etc.
'use strict';
const { detect } = require('./adapter-registry');

const ADAPTERS = Object.freeze({
  'claude-agent': () => require('./adapters/claude-agent'),
  'codex-bash': () => require('./adapters/codex-bash'),
  'gemini-sdk': () => require('./adapters/gemini-sdk'),
  'stdin-fallback': () => require('./adapters/stdin-fallback'),
});

async function refine(eventDraft, sourceExcerpt, { adapter = 'auto', timeoutMs = 30000, ...adapterOpts } = {}) {
  const chosen = detect(adapter);
  const loader = ADAPTERS[chosen];
  if (!loader) throw new Error(`Unknown adapter '${chosen}'`);
  return Promise.race([
    loader().refine(eventDraft, sourceExcerpt, adapterOpts),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`LLM bridge timeout (${chosen}, ${timeoutMs}ms)`), { code: 'TIMEOUT' })), timeoutMs)),
  ]);
}

module.exports = { refine, ADAPTER_NAMES: Object.keys(ADAPTERS) };
```

- [ ] **Step 3: Commit (adapters/ dir will be filled in Phase 3b)**

```bash
git add scripts/lib/adapter-registry.js scripts/lib/llm-bridge.js
git commit -m "feat(phase-1): adapter-registry + llm-bridge skeletons (adapters in Phase 3b)"
```

### Task 1.13: `tests/manifest-drift.test.js` — 3중 version 동기 + Codex 1024-char + strict YAML

**Files:**
- Create: `tests/manifest-drift.test.js`

- [ ] **Step 0 (P19 fix): use `path.resolve(__dirname, '..')` for project root (NEVER absolute hard-coded `/Users/...` paths). All tests must run on any machine and in CI.**

- [ ] **Step 1: Test** (P22 fix — parse YAML properly with `js-yaml`, not regex)

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');  // P22: proper YAML parse

const root = path.resolve(__dirname, '..');  // P19: relative root
const claudeManifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
const codexManifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('version 3중 동기', () => {
  assert.strictEqual(claudeManifest.version, pkg.version);
  assert.strictEqual(codexManifest.version, pkg.version);
});

test('Codex descriptions ≤1024 chars (P22 — covers shortDescription too)', () => {
  assert.ok(codexManifest.description.length <= 1024, `codex description ${codexManifest.description.length} chars`);
  assert.ok(codexManifest.interface.longDescription.length <= 1024, `codex longDescription ${codexManifest.interface.longDescription.length} chars`);
  assert.ok(codexManifest.interface.shortDescription.length <= 1024, `codex shortDescription ${codexManifest.interface.shortDescription.length} chars`);
});

test('All skill SKILL.md frontmatter — js-yaml parse + ≤1024 desc + strict YAML (P22)', () => {
  const skillsDir = path.join(root, 'skills');
  if (!fs.existsSync(skillsDir)) return; // vacuous pass on early phase — P25 mitigated by Phase 2/6 rerun gate (Task 6.1.a below)
  for (const skill of fs.readdirSync(skillsDir)) {
    const sf = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(sf)) continue;
    const txt = fs.readFileSync(sf, 'utf8');
    const fmMatch = txt.match(/^---\n([\s\S]+?)\n---/);
    assert.ok(fmMatch, `${skill}: no frontmatter`);
    let fm;
    try { fm = yaml.load(fmMatch[1]); }
    catch (e) { assert.fail(`${skill}: strict YAML parse error: ${e.message}`); }
    assert.ok(typeof fm.description === 'string' && fm.description.length > 0, `${skill}: missing description`);
    assert.ok(fm.description.length <= 1024, `${skill} description ${fm.description.length} chars (Codex limit)`);
  }
});
```

> **P25 mitigation — Phase 6.1.a rerun gate** (이전 Phase 1 의 vacuous pass 보정): Phase 6.1 의 `npm test` 가 skills/ 가 만들어진 시점에서 manifest-drift test 를 의미 있게 재실행.

> **P26 mitigation — Phase 0 byte assertions**: Task 0.5/0.6/0.7 의 `wc -c` 범위 검증을 upper bound 만으로 완화 (예: `≤2500`, `≤1300`). 정확한 minimum 은 의미 없음 — implementer 가 trivial edit 시 깨질 우려.

- [ ] **Step 2: Run, expect PASS for current phase 0 manifests**

Run: `npx node --test tests/manifest-drift.test.js`

- [ ] **Step 3: Commit**

```bash
git add tests/manifest-drift.test.js
git commit -m "test(phase-1): manifest-drift + Codex 1024-char + strict YAML descriptor guard"
```

---

## Phase 2 — Harvest (1.5일)

목표: `deep-memory-init` + `deep-memory-harvest` skill 정의, `harvest.js` (preflight + project-profile + Step A 매핑 + lease + lock + atomic event append), Phase 1 redact의 Pass 1 동작.

### Task 2.1: `skills/deep-memory-init/SKILL.md`

**Files:**
- Create: `skills/deep-memory-init/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: deep-memory-init
description: "Initialize the deep-memory plugin for first use — preflight memory_root (realpath / writability / NFS / sqlite probe), write config.yaml with schema validation, create ~/.deep-memory/projects/<project_id>.json + project-local .deep-memory/project-profile.json. Triggers on `/deep-memory-init`, \"init memory\", \"deep memory setup\", \"메모리 초기화\", \"deep-memory 셋업\". Optional arg: `<memory_root>` (default ~/.deep-memory/, override via DEEP_MEMORY_ROOT env), and `--allow-network-root` to explicitly allow NFS/network mounts."
user-invocable: true
---

# deep-memory-init — Initialize deep-memory

## Invocation

두 경로 모두 args 동일:
1. Claude Code 슬래시: `/deep-memory-init [memory_root] [--allow-network-root]`
2. 타 에이전트/Codex/Copilot/Gemini/SDK: `Skill({ skill: "deep-memory:deep-memory-init", args: "..." })`

## Inputs

| 인자 | 의미 |
|---|---|
| (없음) | 환경변수 `DEEP_MEMORY_ROOT` 또는 `~/.deep-memory/` 사용 |
| `<memory_root>` | 절대경로 또는 `~`-prefix. POSIX form. |
| `--allow-network-root` | NFS/`/Volumes/`/`/mnt/`/`/net/` 경로 허용 |

## Steps

1. memory_root 결정: arg > env `DEEP_MEMORY_ROOT` > `~/.deep-memory`
2. `scripts/lib/preflight.js` 호출 — error 발생하면 안내 + exit 1
3. `~/.deep-memory/config.yaml` 작성 (없으면) — schema 검증
4. `project-profile.json` 생성 (project-local + global mirror)
5. `~/.deep-memory/{cards,events,indexes,projects,.leases}` 디렉토리 보장
6. 결과를 사용자에게 보고

자세한 절차는 `scripts/init.js` 가 모든 step 을 single command 로 수행.
```

- [ ] **Step 2: Commit (skill만 먼저 — script 다음 task)**

```bash
git add skills/deep-memory-init/SKILL.md
git commit -m "feat(phase-2): skills/deep-memory-init/SKILL.md (script in next task)"
```

### Task 2.2: `scripts/init.js`

**Files:**
- Create: `scripts/init.js`
- Test: `tests/init.test.js`

- [ ] **Step 1: Test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../scripts/init');

test('init creates memory_root subdirectories + config.yaml + project-profile', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-init-'));
  const cwd = process.cwd();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-proj-'));
  process.chdir(projectDir);
  try {
    const r = await run({ memoryRoot: tmp });
    assert.ok(fs.existsSync(path.join(tmp, 'cards')));
    assert.ok(fs.existsSync(path.join(tmp, 'events')));
    assert.ok(fs.existsSync(path.join(tmp, 'indexes')));
    assert.ok(fs.existsSync(path.join(tmp, 'projects')));
    assert.ok(fs.existsSync(path.join(tmp, '.leases')));
    assert.ok(fs.existsSync(path.join(tmp, 'config.yaml')));
    assert.ok(fs.existsSync(path.join(projectDir, '.deep-memory/project-profile.json')));
    const profile = JSON.parse(fs.readFileSync(path.join(projectDir, '.deep-memory/project-profile.json'), 'utf8'));
    assert.match(profile.project_id, /^proj_[a-f0-9]+$/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true });
    fs.rmSync(projectDir, { recursive: true });
  }
});
```

- [ ] **Step 2-4: Implement + test + commit**

```javascript
// scripts/init.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execSync } = require('node:child_process');
const { preflight } = require('./lib/preflight');
const { writeJsonAtomic } = require('./lib/atomic-write');

function resolveMemoryRoot(raw) {
  const root = raw || process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');
  return root.replace(/^~/, os.homedir());
}

function projectId(cwd) {
  let remote = '';
  try { remote = execSync('git config --get remote.origin.url', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const remoteHash = remote ? 'sha256:' + createHash('sha256').update(remote).digest('hex') : 'sha256:none';
  const rootHash = 'sha256:' + createHash('sha256').update(cwd).digest('hex');
  return 'proj_' + createHash('sha256').update(remoteHash + '|' + rootHash).digest('hex').slice(0, 12);
}

function detectLanguages() {
  const languages = new Set();
  const cwd = process.cwd();
  for (const entry of fs.readdirSync(cwd)) {
    if (entry === 'package.json') languages.add('javascript');
    if (entry === 'requirements.txt' || entry === 'pyproject.toml') languages.add('python');
    if (entry === 'go.mod') languages.add('go');
    if (entry === 'Cargo.toml') languages.add('rust');
  }
  // shallow scan for *.sh
  for (const entry of fs.readdirSync(cwd)) {
    if (/\.sh$/.test(entry)) { languages.add('bash'); break; }
  }
  return [...languages];
}

async function run({ memoryRoot, allowNetworkRoot = false } = {}) {
  const resolved = resolveMemoryRoot(memoryRoot);
  const pre = preflight(resolved, { allowNetworkRoot });
  if (!pre.ok) {
    throw new Error(`preflight failed:\n${pre.errors.join('\n')}`);
  }
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(pre.resolved, sub), { recursive: true });
  }
  const configPath = path.join(pre.resolved, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, defaultConfigYaml());
  }
  // project-profile (local + global mirror)
  const cwd = process.cwd();
  const pid = projectId(cwd);
  const profile = {
    project_id: pid,
    repo: {
      remote_url_hash: 'sha256:' + createHash('sha256').update(safeGit('git config --get remote.origin.url')).digest('hex'),
      root_path_hash: 'sha256:' + createHash('sha256').update(cwd).digest('hex'),
      default_branch: safeGit('git symbolic-ref --short HEAD') || 'main',
      git_head: safeGit('git rev-parse HEAD'),
    },
    signature: {
      languages: detectLanguages(),
      runtimes: ['node'], topology: 'unknown',
      test_frameworks: [], package_managers: [], agent_runtime: [],
    },
    suite: { installed_plugins: [] },
    privacy: { scope: 'local', allow_export: false },
    source_mtimes: {},
    generated_at: new Date().toISOString(),
  };
  const localProfileDir = path.join(cwd, '.deep-memory');
  fs.mkdirSync(localProfileDir, { recursive: true });
  writeJsonAtomic(path.join(localProfileDir, 'project-profile.json'), profile);
  writeJsonAtomic(path.join(pre.resolved, 'projects', pid + '.json'), profile);

  return { memoryRoot: pre.resolved, projectId: pid, warnings: pre.warnings };
}

function safeGit(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
}

function defaultConfigYaml() {
  return `version: "0.1.0"
memory_root: ~/.deep-memory
privacy:
  default_scope: local
  allow_export: false
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

module.exports = { run, resolveMemoryRoot, projectId };

if (require.main === module) {
  const args = process.argv.slice(2);
  const memoryRoot = args.find((a) => !a.startsWith('--'));
  const allowNetworkRoot = args.includes('--allow-network-root');
  run({ memoryRoot, allowNetworkRoot }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
```

```bash
git add scripts/init.js tests/init.test.js
git commit -m "feat(phase-2): scripts/init.js — preflight + project-profile + memory_root scaffold"
```

### Task 2.3: `skills/deep-memory-harvest/SKILL.md`

**Files:**
- Create: `skills/deep-memory-harvest/SKILL.md`

- [ ] **Step 1: Write SKILL.md** (description ≤1024 char, strict YAML)

```markdown
---
name: deep-memory-harvest
description: "Scan the current project for deep-suite artifacts (recurring-findings, evolve-insights, session-receipts, docs-scan, wiki-index), apply rule-based extraction (Step A — 5 memory types) + sub-agent refinement (Step B via llm-bridge), apply 3-pass redaction, and persist events + cards under ~/.deep-memory/ with atomic write + project lease + idempotent event keys. Triggers on `/deep-memory-harvest`, \"harvest deep-suite\", \"메모리 수집\", \"메모리 하베스트\", \"deep-memory harvest\". Optional args: `<artifact-path>` (specific source instead of full scan) and `--limit=N` (cap card creation count)."
user-invocable: true
---

# deep-memory-harvest — Scan + distill + persist

## Invocation

1. Claude Code: `/deep-memory-harvest [<artifact-path>] [--limit=N]`
2. Skill: `Skill({ skill: "deep-memory:deep-memory-harvest", args: "..." })`

## Steps

1. Read project-profile from `.deep-memory/project-profile.json`. 없으면 `/deep-memory-init` 안내.
2. `~/.deep-memory/.leases/<project_id>.lease` acquire — 다른 세션이 점유 중이면 abort.
3. Sources를 config.yaml에서 로드 → glob 으로 해당 artifact 발견.
4. 각 artifact 마다:
   - producer/artifact_kind/schema_version 확인 (mis-match 시 skip + warning).
   - Pass 1 redaction → Step A 매핑 → event-draft.
   - Pass 2 redaction → llm-bridge.refine() → Step B 응답 schema validation.
   - Pass 3 redaction → envelope wrap → mkdir lock acquire → dedupe check → card atomic write → events JSONL atomic append → FTS5 transaction commit → lock release.
5. `~/.deep-memory/.leases/<project_id>.lease` release.
6. `.deep-memory/latest-harvest.json` (project-local) atomic write — 사용자 보고.

모든 step 은 `scripts/harvest.js` 가 single command.
```

- [ ] **Step 2: Commit**

```bash
git add skills/deep-memory-harvest/SKILL.md
git commit -m "feat(phase-2): skills/deep-memory-harvest/SKILL.md"
```

### Task 2.4: `scripts/harvest.js` (Step A only — Step B 는 Phase 3a/3b에서 통합)

**Files:**
- Create: `scripts/harvest.js`
- Test: `tests/harvest-golden.test.js`
- Create: `tests/fixtures/sample-recurring-findings.json`

- [ ] **Step 1: Write fixture**

```json
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-review", "producer_version": "1.6.1", "artifact_kind": "recurring-findings",
    "run_id": "01J...", "generated_at": "2026-05-19T00:00:00Z",
    "schema": { "name": "recurring-findings", "version": "1.0" },
    "git": { "head": "abc1234", "branch": "main", "dirty": "false" },
    "provenance": { "source_artifacts": [], "tool_versions": {} }
  },
  "payload": {
    "findings": [
      {
        "title": "Codex skill discovery silently fails on invalid frontmatter",
        "category": "manifest",
        "first_seen": "2026-05-15T00:00:00Z",
        "evidence": ["deep-evolve description trimmed", "deep-wiki YAML parse fix"],
        "tags": ["codex", "skill", "manifest"]
      }
    ]
  }
}
```

- [ ] **Step 2: Write test (Step A only, Step B mocked as noop)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

test('harvest of recurring-findings fixture produces failure-case event-draft', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-harv-'));
  const cards = await harvestArtifact({
    artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
    sourceKind: 'review-recurring',
    memoryRoot: tmp,
    projectId: 'proj_test',
    skipDistillStepB: true, // Phase 2 — Step B not integrated yet
  });
  assert.ok(cards.length >= 1);
  const c = cards[0];
  assert.strictEqual(c.payload.memory_type, 'failure-case');
  assert.ok(c.payload.claim.length > 0, 'F1: claim never empty');
  assert.ok(c.payload.dedupe_key.startsWith('sha256:'));
  fs.rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 3: Implement harvest.js (Step A + persist; Step B integration in Phase 3b)**

핵심 구현 포인트 (full code 길어서 outline 만 — implementer 가 spec §7.1/§7.3 + 위 lib 참조):

```javascript
// scripts/harvest.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { glob } = require('node:fs');
const { createHash } = require('node:crypto');
const { wrap, ulidLike } = require('./lib/envelope');
const { redactObject } = require('./lib/redact');
const { dedupeKey } = require('./lib/dedupe');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { hashFile } = require('./lib/source-hash');
const { acquire, release } = require('./lib/lock');

const STEP_A_MAPPERS = {
  'review-recurring': mapRecurringFindings,
  'evolve-insights': mapEvolveInsights,
  'work-receipt': mapWorkReceipt,
  'docs-scan': mapDocsScan,
  'wiki-index': mapWikiIndex,
};

function mapRecurringFindings(artifact, sourceArtifactMeta) {
  const findings = artifact.payload?.findings || [];
  return findings.map((f) => ({
    memory_type: 'failure-case',
    title: f.title,
    claim: f.title, // F1 — claim never empty
    evidence_summary: (f.evidence || []).slice(0, 5),
    applicability: f.category ? [{ value: f.category, source_id: sourceArtifactMeta.id, confidence: 0.7 }] : [],
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: f.tags || [],
    created_at: f.first_seen || new Date().toISOString(),
  }));
}
// (mapEvolveInsights / mapWorkReceipt / mapDocsScan / mapWikiIndex — spec §7.1 표 참조)

async function harvestArtifact({ artifactPath, sourceKind, memoryRoot, projectId, skipDistillStepB = false }) {
  const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const sourceMeta = {
    id: 'src_0',
    path: artifactPath,
    content_hash: hashFile(artifactPath),
    captured_at: new Date().toISOString(),
    artifact_kind: raw.envelope?.artifact_kind || sourceKind,
    schema_version: raw.envelope?.schema?.version || '1.0',
    run_id: raw.envelope?.run_id || 'unknown',
  };
  const mapper = STEP_A_MAPPERS[sourceKind];
  if (!mapper) throw new Error(`Unknown sourceKind: ${sourceKind}`);
  let drafts = mapper(redactObject(raw), sourceMeta);
  // claim never-empty invariant (F1)
  drafts = drafts.filter((d) => {
    if (!d.claim || !d.title || !d.evidence_summary?.length) {
      // quarantine omitted in Phase 2 — Phase 3a adds full quarantine path
      return false;
    }
    return true;
  });

  if (!skipDistillStepB) {
    // wiring done in Phase 3b
  }

  const cards = [];
  for (const d of drafts) {
    const dk = dedupeKey(d.memory_type, d.claim, d.applicability);
    const id = 'mem_' + d.memory_type.replace('-', '_') + '_' + createHash('sha256').update(dk).digest('hex').slice(0, 6);
    const payload = {
      ...d,
      memory_id: id,
      dedupe_key: dk,
      privacy_level: 'local',
      status: 'candidate',
      status_history: [],
      last_seen_at: new Date().toISOString(),
      review_after: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
      feedback: { accepted_count: 0, rejected_count: 0, inaccurate_count: 0 },
      confidence: 0.5,
    };
    const card = wrap({
      artifact_kind: 'memory-card',
      schema: { name: 'memory-card', version: '1.0' },
      payload,
      provenance: { source_artifacts: [sourceMeta] },
    });
    cards.push(card);
  }

  // persist (lock + atomic) — simplified for Phase 2 (full lock + lease + FTS5 in Phase 4)
  const dir = path.join(memoryRoot, 'cards', cards[0]?.payload?.memory_type || 'unknown', projectId);
  fs.mkdirSync(dir, { recursive: true });
  for (const c of cards) {
    writeJsonAtomic(path.join(dir, c.payload.memory_id + '.json'), c);
  }
  return cards;
}

module.exports = { harvestArtifact };
```

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/harvest.js tests/harvest-golden.test.js tests/fixtures/sample-recurring-findings.json
git commit -m "feat(phase-2): scripts/harvest.js Step A mapping + persist + claim never-empty (F1)"
```

### Task 2.5: harvest.js — lock + lease + idempotent events JSONL + FTS5 upsert (P3 fix — spec §7.3 통합)

**Files:**
- Modify: `scripts/harvest.js`
- Test: `tests/concurrent-harvest.test.js`

이전 Task 2.4 의 "persist (lock + atomic) — simplified for Phase 2" 코멘트가 가리킨 retrofit. 누락되면 spec §7.3 invariant (concurrent harvest race + idempotent + FTS5) 가 implementation 끝까지 미달성.

- [ ] **Step 1: Write test (P3 — concurrent harvest produces no duplicate events)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

test('concurrent harvest of same artifact produces single event (idempotent key)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conc-'));
  const fixturePath = path.join(__dirname, 'fixtures/sample-recurring-findings.json');
  const opts = { artifactPath: fixturePath, sourceKind: 'review-recurring', memoryRoot: tmp, projectId: 'proj_test', skipDistillStepB: true };
  await Promise.all([harvestArtifact(opts), harvestArtifact(opts)]);
  const eventsFile = path.join(tmp, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
  const lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.strictEqual(lines.length, 1, `expected 1 idempotent event, got ${lines.length}`);
  fs.rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run, expect FAIL** (current harvest does not check lease / event key).

- [ ] **Step 3: Implement (project lease + global lock + idempotent event key + FTS5 upsert in same lock)**

```javascript
// scripts/harvest.js (additions — wrap existing persist with lease + lock + event idempotency + FTS5)
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { acquire, release, StaleLockError } = require('./lib/lock');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { openIndex, upsertCard } = require('./lib/fts-index');

function eventKey(sourceMeta, runId) {
  return createHash('sha256').update([sourceMeta.path, sourceMeta.content_hash, runId].join('|')).digest('hex');
}

async function persistWithLockAndLease({ memoryRoot, projectId, cards, sourceMeta, runId }) {
  // 1. lease
  const leaseDir = path.join(memoryRoot, '.leases');
  fs.mkdirSync(leaseDir, { recursive: true });
  const leasePath = path.join(leaseDir, projectId + '.lease');
  if (fs.existsSync(leasePath)) {
    const meta = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const age = Date.now() - new Date(meta.started_at).getTime();
    if (age < 30 * 60 * 1000) {
      throw new Error(`Another session already harvesting project ${projectId} (started ${meta.started_at}, pid ${meta.pid}). Try later or wait ~30min for stale-break.`);
    }
  }
  writeJsonAtomic(leasePath, { pid: process.pid, host: require('os').hostname(), started_at: new Date().toISOString() });

  // 2. global lock
  const lockPath = path.join(memoryRoot, '.lock');
  const handle = await acquire(lockPath, { operation: 'harvest' });
  try {
    // 3. event idempotent append
    const yearMonth = new Date().toISOString().slice(0, 7);
    const eventsFile = path.join(memoryRoot, 'events', yearMonth + '.jsonl');
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    const existing = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    const key = eventKey(sourceMeta, runId);
    if (!existing.includes(`"event_key":"${key}"`)) {
      const event = { event_key: key, source: sourceMeta, run_id: runId, at: new Date().toISOString(), cards_count: cards.length };
      fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
    }
    // 4. card atomic write (existing logic in harvestArtifact moved here)
    for (const c of cards) {
      const memDir = path.join(memoryRoot, 'cards', c.payload.memory_type, projectId);
      fs.mkdirSync(memDir, { recursive: true });
      writeJsonAtomic(path.join(memDir, c.payload.memory_id + '.json'), c);
    }
    // 5. FTS5 upsert in same lock window (spec §7.3 step 7 — commit before release)
    const idx = openIndex(path.join(memoryRoot, 'indexes', 'lexical.sqlite'));
    try {
      // Transaction handled implicitly by better-sqlite3 for single-statement calls;
      // for multi-card batches wrap in explicit BEGIN/COMMIT if driver === 'better-sqlite3'.
      if (idx.driver === 'better-sqlite3') idx.db.exec('BEGIN');
      for (const c of cards) {
        upsertCard(idx, c, { projectId });
      }
      if (idx.driver === 'better-sqlite3') idx.db.exec('COMMIT');
    } finally {
      if (idx.driver === 'better-sqlite3') idx.db.close();
    }
  } finally {
    release(handle);
    try { fs.unlinkSync(leasePath); } catch {}
  }
}
```

- [ ] **Step 4: Run test, expect PASS** (single event line written even with 2 concurrent harvests).

- [ ] **Step 5: Commit**

```bash
git add scripts/harvest.js tests/concurrent-harvest.test.js
git commit -m "feat(phase-2): Task 2.5 — harvest.js lease + lock + idempotent event + FTS5 upsert (P3)"
```

---

## Phase 3a — Distill rule (Step A complete, 2.5일 — P2 expand + P29 re-estimate)

목표: 5 memory_type 전부 mapper 구현 + empty-claim quarantine 정책 + golden test 5개. **P2 fix — 각 mapper 마다 독립 task** (이전 "Similar to Task N" 압축은 implementer 의 design 재도출 위험).

### Task 3a.1: `mapEvolveInsights` — experiment-outcome

**Files:**
- Modify: `scripts/harvest.js`
- Create: `tests/fixtures/sample-evolve-insights.json`
- Create: `tests/fixtures/golden-cards/expected_experiment-outcome.json`
- Test: extend `tests/harvest-golden.test.js`

- [ ] **Step 1: Write fixture** (`sample-evolve-insights.json`)

```json
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-evolve", "producer_version": "3.4.2", "artifact_kind": "evolve-insights",
    "run_id": "01J_evolve...", "generated_at": "2026-05-19T00:00:00Z",
    "schema": { "name": "evolve-insights", "version": "1.0" },
    "git": { "head": "def5678", "branch": "main", "dirty": "false" },
    "provenance": { "source_artifacts": [], "tool_versions": {} }
  },
  "payload": {
    "insights": [
      {
        "strategy": "start with manifest drift tests before behavior tests",
        "q_delta": 0.18,
        "project_signature": { "language": "typescript", "topology": "plugin" },
        "outcome": "caught Codex compatibility regressions early"
      }
    ]
  }
}
```

- [ ] **Step 2: Write golden expected card** (`expected_experiment-outcome.json`) — exact payload after Step A mapping (Step B mocked).

- [ ] **Step 3: Write failing test extension**

```javascript
test('Step A: mapEvolveInsights — strategy → claim, q_delta normalized to confidence', async () => {
  // ...
});
```

- [ ] **Step 4: Run, expect FAIL** (mapper not yet implemented).

- [ ] **Step 5: Implement mapEvolveInsights**

```javascript
function mapEvolveInsights(artifact, sourceMeta) {
  const insights = artifact.payload?.insights || [];
  return insights.map((i) => ({
    memory_type: 'experiment-outcome',
    title: i.strategy,
    claim: i.strategy,  // F1: claim never empty
    evidence_summary: [i.outcome].filter(Boolean).slice(0, 5),
    applicability: Object.entries(i.project_signature || {}).map(([k, v]) => ({
      value: `${k}=${v}`, source_id: sourceMeta.id, confidence: 0.7,
    })),
    non_applicability: [],
    recommended_action: [],
    search_keywords: [],
    tags: ['evolve', 'experiment'],
    confidence: Math.max(0, Math.min(1, (i.q_delta || 0) / 0.5)),  // normalize q_delta to 0-1 (0.5 saturates to 1.0)
    created_at: new Date().toISOString(),
  }));
}
```

- [ ] **Step 6: Run test, expect PASS**.

- [ ] **Step 7: Commit**

```bash
git add scripts/harvest.js tests/fixtures/sample-evolve-insights.json tests/fixtures/golden-cards/expected_experiment-outcome.json tests/harvest-golden.test.js
git commit -m "feat(phase-3a): Task 3a.1 mapEvolveInsights — strategy→claim, q_delta→confidence"
```

### Task 3a.2: `mapWorkReceipt` — pattern (성공 slice) / failure-case (실패 slice)

**Files:**
- Modify: `scripts/harvest.js`
- Create: `tests/fixtures/sample-session-receipt-success.json`
- Create: `tests/fixtures/sample-session-receipt-failure.json`
- Create: `tests/fixtures/golden-cards/expected_pattern.json`
- Create: `tests/fixtures/golden-cards/expected_failure-case-slice.json`

- [ ] **Step 1-2: Fixtures** (success slice + failure slice)

```json
// sample-session-receipt-success.json
{
  "schema_version": "1.0",
  "envelope": { "producer": "deep-work", "producer_version": "6.8.0", "artifact_kind": "session-receipt",
    "run_id": "01J_work...", "generated_at": "2026-05-19T00:00:00Z",
    "schema": { "name": "session-receipt", "version": "1.0" },
    "git": { "head": "ghi9012", "branch": "main", "dirty": "false" },
    "provenance": { "source_artifacts": [], "tool_versions": {} }
  },
  "payload": {
    "slices": [
      { "id": "SLICE-001", "title": "implement envelope wrap", "outcome": "success", "outcome_summary": "all tests pass", "failure_reason": null }
    ]
  }
}
```

- [ ] **Step 3-7: Test + impl + commit**

```javascript
function mapWorkReceipt(artifact, sourceMeta) {
  const slices = artifact.payload?.slices || [];
  const out = [];
  for (const s of slices) {
    if (s.outcome === 'success') {
      out.push({
        memory_type: 'pattern',
        title: s.title,
        claim: `Pattern: ${s.title} — ${s.outcome_summary || 'success'}`,
        evidence_summary: [s.id],
        applicability: [],
        non_applicability: [],
        recommended_action: [],
        search_keywords: [],
        tags: ['deep-work', 'pattern'],
        confidence: 0.5, created_at: new Date().toISOString(),
      });
    } else if (s.outcome === 'failure') {
      out.push({
        memory_type: 'failure-case',
        title: s.title,
        claim: `Failure: ${s.title} — ${s.failure_reason || 'unspecified'}`,
        evidence_summary: [s.id],
        applicability: [],
        non_applicability: [],
        recommended_action: [],
        search_keywords: [],
        tags: ['deep-work', 'failure-case'],
        confidence: 0.5, created_at: new Date().toISOString(),
      });
    }
  }
  return out;
}
```

```bash
git add scripts/harvest.js tests/fixtures/sample-session-receipt-*.json tests/fixtures/golden-cards/expected_pattern.json tests/fixtures/golden-cards/expected_failure-case-slice.json tests/harvest-golden.test.js
git commit -m "feat(phase-3a): Task 3a.2 mapWorkReceipt — pattern + failure-case slice branching"
```

### Task 3a.3: `mapDocsScan` — coding-style

**Files:**
- Modify: `scripts/harvest.js`
- Create: `tests/fixtures/sample-last-scan.json`
- Create: `tests/fixtures/golden-cards/expected_coding-style.json`

- [ ] **Step 1-7: Fixture + test + impl + commit** (same TDD shape as 3a.1)

```javascript
function mapDocsScan(artifact, sourceMeta) {
  const drifts = artifact.payload?.drifts || [];
  return drifts.map((d) => ({
    memory_type: 'coding-style',
    title: d.title,
    claim: `${d.title} — ${d.recommended_fix || 'no recommendation'}`,
    evidence_summary: [d.path].filter(Boolean).slice(0, 5),
    applicability: d.language ? [{ value: `language=${d.language}`, source_id: sourceMeta.id, confidence: 0.6 }] : [],
    non_applicability: [], recommended_action: d.recommended_fix ? [d.recommended_fix] : [],
    search_keywords: [], tags: ['deep-docs', 'style'],
    confidence: 0.5, created_at: new Date().toISOString(),
  }));
}
```

```bash
git commit -m "feat(phase-3a): Task 3a.3 mapDocsScan — drift→coding-style"
```

### Task 3a.4: `mapWikiIndex` — architecture-decision (ADR filter)

**Files:**
- Modify: `scripts/harvest.js`
- Create: `tests/fixtures/sample-wiki-index.json`
- Create: `tests/fixtures/golden-cards/expected_architecture-decision.json`

- [ ] **Step 1-7**: same TDD; ADR filter = `page.frontmatter.adr === true`

```javascript
function mapWikiIndex(artifact, sourceMeta) {
  const pages = artifact.payload?.pages || [];
  return pages.filter((p) => p.frontmatter?.adr === true).map((p) => ({
    memory_type: 'architecture-decision',
    title: p.title || p.path,
    claim: p.frontmatter?.decision_summary || p.title || p.path,
    evidence_summary: [p.path].filter(Boolean).slice(0, 5),
    applicability: [], non_applicability: [], recommended_action: [],
    search_keywords: [], tags: ['wiki', 'adr'],
    confidence: 0.7, created_at: new Date().toISOString(),
  }));
}
```

```bash
git commit -m "feat(phase-3a): Task 3a.4 mapWikiIndex — ADR-tagged wiki pages → architecture-decision"
```

### Task 3a.5: Wire all 5 mappers + STEP_A_MAPPERS registry

**Files:**
- Modify: `scripts/harvest.js`

- [ ] **Step 1: Verify STEP_A_MAPPERS** has all 5 entries

```javascript
const STEP_A_MAPPERS = {
  'review-recurring': mapRecurringFindings,
  'evolve-insights': mapEvolveInsights,
  'work-receipt': mapWorkReceipt,
  'docs-scan': mapDocsScan,
  'wiki-index': mapWikiIndex,
};
```

- [ ] **Step 2: Run all golden tests, expect PASS**

```bash
node --test tests/harvest-golden.test.js
```

- [ ] **Step 3: Commit** (R3 fix — STEP_A_MAPPERS dict assembly 가 실제 file 변경이므로 `--allow-empty` 제거)

```bash
git add scripts/harvest.js
git commit -m "chore(phase-3a): Task 3a.5 — all 5 STEP_A_MAPPERS wired (review/evolve/work/docs/wiki)"
```

### Task 3a.6: Quarantine invariant

**Files:**
- Modify: `scripts/harvest.js`
- Test: `tests/harvest-golden.test.js` (extend)

- [ ] **Step 1: Add test**

```javascript
test('empty-claim draft is quarantined (not persisted)', async () => {
  // ... pass artifact missing required fields
  // verify .quarantine/empty-claim/<run_id>.json exists
});
```

- [ ] **Step 2-4: Implement quarantine in harvest.js (write to `<memoryRoot>/.quarantine/empty-claim/<run_id>.json`), test, commit.

---

## Phase 3b — Distill sub-agent + bridge (2.5일)

목표: `agents/memory-distiller.md` + 3 adapter (claude-agent / codex-bash / stdin-fallback) + Step B output schema validation + golden eval harness + runtime-contract fixtures.

### Task 3b.1: `agents/memory-distiller.md` sub-agent definition

**Files:**
- Create: `agents/memory-distiller.md`

- [ ] **Step 1: Write sub-agent definition (Read-only role, no Write/Edit)**

```markdown
---
name: memory-distiller
description: Refine a deep-memory event-draft by filling LLM-derived fields (claim_refined / non_applicability / recommended_action / search_keywords). Read-only — never writes files. Input: event-draft JSON + source artifact excerpt (max 4096 bytes, redaction-applied). Output: JSON matching memory-card-distill-output.schema.json.
tools: Read, Glob, Grep
---

# memory-distiller

You receive a deep-memory event-draft (rule-extracted) plus a source artifact excerpt. Your job is to refine the LLM-derived fields:

- `claim_refined`: improve the claim text (Step A's baseline is a starting point — never empty)
- `non_applicability`: when this memory should NOT be applied (list of `{value, confidence}`)
- `recommended_action`: list of concrete actions
- `search_keywords`: max 15 synonyms / related concepts

Constraints:
- Output JSON ONLY, matching `schemas/memory-card-distill-output.schema.json`.
- Do NOT modify or include fields that Step A already filled (Step A's `claim`, `evidence_summary`, `applicability`, `tags`, `created_at` are authoritative).
- Do NOT echo the source excerpt back.
- Do NOT include PII, secrets, customer names, or proprietary code. If the source contains them despite redaction, mention only the redacted form.

Output format:
```json
{
  "claim_refined": "...",
  "non_applicability": [{"value":"...", "confidence":0.8}],
  "recommended_action": ["..."],
  "search_keywords": ["..."]
}
```
```

- [ ] **Step 2: Commit**

```bash
git add agents/memory-distiller.md
git commit -m "feat(phase-3b): agents/memory-distiller.md sub-agent (Read-only role)"
```

### Task 3b.2: Adapter `scripts/lib/adapters/claude-agent.js`

**Files:**
- Create: `scripts/lib/adapters/claude-agent.js`
- Test: `tests/runtime-contract/claude-adapter.test.js`
- Create: `tests/fixtures/runtime-recorded/claude-agent.jsonl`

- [ ] **Step 1: Recorded fixture (canned response for tests)**

```jsonl
{"adapter":"claude-agent","input_hash":"sha256:test1","output":{"claim_refined":"Codex skill discovery silently fails on invalid YAML frontmatter — validate strictly","non_applicability":[{"value":"Claude Code slash-command-only plugin","confidence":0.8}],"recommended_action":["Run skill-reviewer per release"],"search_keywords":["codex","skill","yaml","frontmatter","strict parse","manifest"]}}
```

- [ ] **Step 2: Write test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const adapter = require('../../scripts/lib/adapters/claude-agent');

test('claude-adapter recorded fixture returns valid distill output', async () => {
  const out = await adapter.refine({
    memory_type: 'failure-case',
    claim: 'test claim',
  }, 'source excerpt', { recordedFixture: path.join(__dirname, '../fixtures/runtime-recorded/claude-agent.jsonl') });
  assert.ok(out.claim_refined);
  assert.ok(Array.isArray(out.search_keywords));
});

test('claude-adapter without recorded fixture and no live Agent throws typed ADAPTER_NOT_WIRED', async () => {
  await assert.rejects(
    () => adapter.refine({}, '', { recordedFixture: null, liveAgent: false }),
    (e) => e.code === 'ADAPTER_NOT_WIRED'
  );
});
```

- [ ] **Step 3: Implement adapter (P4 fix — typed error code so harvest gracefully degrades)**

```javascript
// scripts/lib/adapters/claude-agent.js
'use strict';
const fs = require('node:fs');

async function refine(eventDraft, sourceExcerpt, { recordedFixture = null, liveAgent = false } = {}) {
  if (recordedFixture) {
    const lines = fs.readFileSync(recordedFixture, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0]);
    return rec.output;
  }
  if (liveAgent) {
    // Phase 3b real-host smoke test will populate this — invoke memory-distiller sub-agent
    // via the Claude Code Agent tool. Implementer wires the actual Agent() call here.
    // For MVP, only recordedFixture path is exercised; live path is enabled when wiring exists.
    throw Object.assign(
      new Error('claude-agent live dispatch not yet wired — pass {recordedFixture: ...} for MVP'),
      { code: 'ADAPTER_NOT_WIRED' }
    );
  }
  // P4: typed code → harvest catches and falls back to candidate (no MVP crash)
  throw Object.assign(
    new Error('claude-agent: no recorded fixture and live Agent disabled'),
    { code: 'ADAPTER_NOT_WIRED' }
  );
}

module.exports = { refine };
```

- [ ] **Step 4-5: Test PASS + commit**

```bash
git add scripts/lib/adapters/claude-agent.js tests/runtime-contract/claude-adapter.test.js tests/fixtures/runtime-recorded/claude-agent.jsonl
git commit -m "feat(phase-3b): adapters/claude-agent.js + recorded fixture contract test"
```

### Task 3b.3: Adapter `scripts/lib/adapters/codex-bash.js`

**Files:**
- Create: `scripts/lib/adapters/codex-bash.js`
- Test: `tests/runtime-contract/codex-adapter.test.js`
- Create: `tests/fixtures/runtime-recorded/codex-bash.jsonl`

Similar TDD pattern to Task 3b.2 — adapter calls `codex review --json` via `spawn`, parses stdout, validates against `memory-card-distill-output.schema.json`.

- [ ] **Step 1-5: fixture / test / impl / pass / commit**

```javascript
// scripts/lib/adapters/codex-bash.js (outline)
const { spawn } = require('node:child_process');
async function refine(eventDraft, sourceExcerpt, { recordedFixture = null } = {}) {
  if (recordedFixture) return readRecorded(recordedFixture);
  // production: spawn codex with prompt template, capture stdout, JSON.parse
}
module.exports = { refine };
```

### Task 3b.4: Adapter `scripts/lib/adapters/stdin-fallback.js`

**Files:**
- Create: `scripts/lib/adapters/stdin-fallback.js`
- Test: `tests/runtime-contract/stdin-fallback.test.js`
- Create: `tests/fixtures/runtime-recorded/stdin-fallback.jsonl`

배치 모드 (Q5) — accumulate event-drafts → 사용자에게 한 번 prompt → JSON paste 받음. Phase 3b 종료 게이트에서 prototype 결과로 결정. MVP 는 fixture mode 가 주.

### Task 3b.5: Step B output schema validation in `llm-bridge.js`

**Files:**
- Modify: `scripts/lib/llm-bridge.js`
- Test: `tests/runtime-contract/schema-validation.test.js`

- [ ] **Step 1: Test (모든 adapter 출력이 schema 통과해야)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats').default;
const fs = require('node:fs');
const path = require('node:path');
const { refine } = require('../../scripts/lib/llm-bridge');

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/memory-card-distill-output.schema.json'), 'utf8'));
const validate = ajv.compile(schema);

test('llm-bridge.refine returns schema-valid output (claude adapter fixture)', async () => {
  const out = await refine({}, '', { adapter: 'claude-agent', recordedFixture: path.join(__dirname, '../fixtures/runtime-recorded/claude-agent.jsonl') });
  assert.ok(validate(out), JSON.stringify(validate.errors));
});
```

- [ ] **Step 2-4: Modify llm-bridge.js to validate output before returning (throw → trigger candidate fallback)**

```javascript
// scripts/lib/llm-bridge.js (P14 fix — adapter allowlist instead of require path injection; P15 fix — adapterOpts pass-through from Phase 1)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats').default;
const { detect } = require('./adapter-registry');

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schemas/memory-card-distill-output.schema.json'), 'utf8'));
const validate = ajv.compile(schema);

// P14: allowlist — adapter name from config/user never reaches require() path argument
const ADAPTERS = Object.freeze({
  'claude-agent': () => require('./adapters/claude-agent'),
  'codex-bash': () => require('./adapters/codex-bash'),
  'gemini-sdk': () => require('./adapters/gemini-sdk'),
  'stdin-fallback': () => require('./adapters/stdin-fallback'),
});

async function refine(eventDraft, sourceExcerpt, { adapter = 'auto', timeoutMs = 30000, ...adapterOpts } = {}) {
  const chosen = detect(adapter);
  const loader = ADAPTERS[chosen];
  if (!loader) {
    throw new Error(`Unknown adapter '${chosen}'. Allowed: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  const mod = loader();
  const out = await Promise.race([
    mod.refine(eventDraft, sourceExcerpt, adapterOpts),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`LLM bridge timeout (${chosen}, ${timeoutMs}ms)`), { code: 'TIMEOUT' })), timeoutMs)),
  ]);
  if (!validate(out)) {
    const err = new Error(`Step B output schema violation: ${ajv.errorsText(validate.errors)}`);
    err.code = 'SCHEMA_VIOLATION';
    throw err;
  }
  return out;
}

module.exports = { refine, ADAPTER_NAMES: Object.keys(ADAPTERS) };
```

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/llm-bridge.js tests/runtime-contract/schema-validation.test.js
git commit -m "feat(phase-3b): llm-bridge Step B output schema validation (F5)"
```

### Task 3b.6: Integrate Step B into `harvest.js` + Pass 2 redaction

**Files:**
- Modify: `scripts/harvest.js`
- Test: `tests/distill-golden.test.js`

- [ ] **Step 1-5: TDD — golden fixture round-trip (harvest input → expected card output, Step B via recorded adapter)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { harvestArtifact } = require('../scripts/harvest');

test('distill golden: recurring-findings → expected failure-case card', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gold-'));
  const out = await harvestArtifact({
    artifactPath: path.join(__dirname, 'fixtures/sample-recurring-findings.json'),
    sourceKind: 'review-recurring',
    memoryRoot: tmp, projectId: 'proj_test',
    llmAdapter: 'claude-agent',
    llmRecordedFixture: path.join(__dirname, 'fixtures/runtime-recorded/claude-agent.jsonl'),
  });
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/golden-cards/expected_failure_recurring.json'), 'utf8'));
  // Rule-fields exact match
  assert.deepStrictEqual(out[0].payload.evidence_summary, expected.payload.evidence_summary);
  assert.deepStrictEqual(out[0].payload.tags, expected.payload.tags);
  // LLM-derived: keyword presence check (Step B output may vary across recorded fixtures, but key terms must appear)
  assert.ok(out[0].payload.claim.toLowerCase().includes('codex') || out[0].payload.claim.toLowerCase().includes('skill'));
  fs.rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2-5: Modify harvest.js to call llm-bridge.refine + Pass 2 redact (source excerpt before sending) + Pass 3 redact (envelope wrap), + Step A field preservation invariant**

```javascript
// scripts/harvest.js (additions to harvestArtifact)
// P1 fix — real require from llm-bridge (no 'placeholder' literal), use existing draft variable `d`, JSON.stringify before slice
const { refine: llmBridgeRefine } = require('./lib/llm-bridge');

for (const d of drafts) {
  // Pass 2 redaction of source excerpt (P14 namespace agreed with §11.1)
  const sourceExcerpt = JSON.stringify(redactObject(raw.payload)).slice(0, 4096);
  let stepBOutput = null;
  try {
    stepBOutput = await llmBridgeRefine(d, sourceExcerpt, {
      adapter: llmAdapter,
      recordedFixture: llmRecordedFixture,
    });
  } catch (e) {
    if (e.code === 'SCHEMA_VIOLATION' || e.code === 'TIMEOUT' || e.code === 'ADAPTER_NOT_WIRED') {
      stepBOutput = null;  // graceful fallback to candidate (spec §7.2)
    } else {
      throw e;  // unexpected — let caller see it
    }
  }
  // Merge: Step A fields are authoritative; only fill LLM-derived empties
  if (stepBOutput) {
    d.claim = (stepBOutput.claim_refined && d.claim === d.title) ? stepBOutput.claim_refined : d.claim;
    d.non_applicability = stepBOutput.non_applicability.map((x) => ({ value: x.value, source_id: 'src_0', confidence: x.confidence }));
    d.recommended_action = stepBOutput.recommended_action;
    d.search_keywords = stepBOutput.search_keywords;
    d.confidence = 0.7;
    d.status = 'candidate'; // audit promotes to validated
  } else {
    d.confidence = 0.4;
    d.status = 'candidate';
  }
  // Pass 3 redaction at envelope wrap boundary
  const wrapped = redactObject(wrap({
    artifact_kind: 'memory-card',
    schema: { name: 'memory-card', version: '1.0' },
    payload: d,
    provenance: { source_artifacts: [sourceMeta] },
  }));
  // ... persist (see Task 2.5 for full lock + lease + atomic + FTS upsert wiring)
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/harvest.js tests/distill-golden.test.js tests/fixtures/golden-cards/expected_failure_recurring.json
git commit -m "feat(phase-3b): harvest.js Step B integration + Pass 2/3 redaction + Step A invariant"
```

### Task 3b.7: `stdin-fallback` batch mode prototype + Q5 결정 게이트

**Files:**
- Modify: `scripts/lib/adapters/stdin-fallback.js`

- [ ] **Step 1**: implement batch buffer (collect drafts → on flush, prompt user via stderr → read JSON from stdin → distribute to drafts).
- [ ] **Step 2**: prototype 후 Q5 결정 (사용자에게 a/b 의견 묻기 OR spec update commit).

---

## Phase 4 — Brief (1.5일)

목표: `deep-memory-brief` skill + `retrieve.js` + FTS5 index 모듈 + ranking pipeline (0-1 정규화) + JSON+MD 출력 + privacy scope filter + degraded paths.

### Task 4.1: `skills/deep-memory-brief/SKILL.md`

(skill definition, similar pattern to harvest)

### Task 4.2: `scripts/lib/fts-index.js` — FTS5 wrapper

**Files:**
- Create: `scripts/lib/fts-index.js`
- Test: `tests/fts-index.test.js`

- [ ] **Step 1: Test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, search } = require('../scripts/lib/fts-index');

test('upsert + search returns BM25-ranked rows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fts-'));
  const idx = openIndex(path.join(tmp, 'lexical.sqlite'));
  upsertCard(idx, { memory_id: 'mem_a', payload: { claim: 'Codex skill discovery fails on invalid YAML', tags: ['codex','skill'], applicability: [{value:'plugin migration'}], search_keywords: ['frontmatter','yaml'] }, privacy_level: 'global', memory_type: 'failure-case' });
  upsertCard(idx, { memory_id: 'mem_b', payload: { claim: 'Use TypeScript strict mode', tags: ['typescript'], applicability: [{value:'frontend'}], search_keywords: [] }, privacy_level: 'global', memory_type: 'pattern' });
  const r = search(idx, 'codex skill yaml', { topN: 5 });
  assert.strictEqual(r[0].memory_id, 'mem_a');
  fs.rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run, expect FAIL** — `Cannot find module '../scripts/lib/fts-index'`.

- [ ] **Step 3: Implement (P7+P12+P14 fix — real driver registry with sql.js fallback + accept card payload shape + project_id explicit)**

```javascript
// scripts/lib/fts-index.js
// R3 P7 fix — sql.js fallback was import-only (openIndex throws on it); confusing/silent-crash risk.
// v0.1.0 MVP: better-sqlite3 is a HARD DEPENDENCY. Phase 0 install probe (check-sqlite.js) must pass.
// sql.js WASM fallback (functional wrapper) is moved to docs/handoff-phase-4-6.md (future Phase 4+).
'use strict';

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error(
    `deep-memory v0.1.0 requires better-sqlite3 (native module). Install build tools or use Node image with prebuilt binaries.\n` +
    `Future versions (Phase 4+) will add a sql.js WASM wrapper — see docs/handoff-phase-4-6.md.\n` +
    `Original error: ${e.message}`
  );
}

function openIndex(filepath) {
  const db = new Database(filepath);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS cards USING fts5(
      memory_id UNINDEXED,
      memory_type UNINDEXED,
      privacy_level UNINDEXED,
      project_id UNINDEXED,
      claim, tags, applicability, search_keywords
    );
  `);
  return { driver: 'better-sqlite3', db };
}

function upsertCard(idx, card, { projectId = null } = {}) {
  // P12 fix — accept the wrapped card shape (card.payload.*) AND pass project_id explicitly
  const p = card.payload || card;  // tolerate both shapes (legacy tests use flat)
  const pid = projectId || card.project_id || p.project_id || '';
  idx.db.prepare('DELETE FROM cards WHERE memory_id = ?').run(p.memory_id);
  idx.db.prepare(`INSERT INTO cards (memory_id, memory_type, privacy_level, project_id, claim, tags, applicability, search_keywords) VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      p.memory_id, p.memory_type, p.privacy_level, pid,
      p.claim,
      (p.tags || []).join(' '),
      (p.applicability || []).map((a) => typeof a === 'string' ? a : a.value).join(' '),
      (p.search_keywords || []).join(' ')
    );
}

function search(idx, query, { topN = 8, projectId = null } = {}) {
  // privacy scope: local cards visible only to same project_id; global cards to all (spec §8)
  // P13 fix downstream: caller must pass results through bm25MinMax (which inverts since smaller bm25 = better match)
  const rows = idx.db.prepare(`
    SELECT memory_id, memory_type, privacy_level, project_id, bm25(cards) AS bm25
    FROM cards
    WHERE cards MATCH ?
      AND (privacy_level = 'global' OR project_id = ?)
    ORDER BY bm25 ASC
    LIMIT ?
  `).all(query, projectId || '', topN * 3); // overfetch ×3 for diversity stage
  return rows;
}

module.exports = { openIndex, upsertCard, search, driverName };
```

```bash
git add scripts/lib/fts-index.js tests/fts-index.test.js
git commit -m "feat(phase-4): scripts/lib/fts-index.js — FTS5 with privacy scope filter"
```

### Task 4.3: `scripts/retrieve.js` — ranking pipeline (6 stages — P16 stage order explicit)

**Files:**
- Create: `scripts/retrieve.js`
- Test: `tests/retrieve-ranking.test.js`

**P16 fix — explicit stage ordering**:

```
Stage 0  fts-index.search(query, {projectId, topN: N*3})         # FTS5 BM25 overfetch
Stage 1  hard filter: status != deprecated + review_after age   # 같은 lock 안, FTS 직후
Stage 2  bm25MinMax over the *post-hard-filter* set              # min-max scaling 범위 = 살아남은 후보만
Stage 3  load full card payloads (one DB lookup per memory_id)  # FTS columns 외 필드 필요
Stage 4  project_sim (Jaccard on languages/runtimes)            # missing-profile → w_project_sim=0
Stage 5  evidence_quality (sigmoid clamp via score.js)          # confidence × log(1+n) × (1−rejected/...)
Stage 6  applicability guard: drop card if task tokens ∩ any non_applicability.value (Jaccard ≥ 0.5)
Stage 7  diversity: per memory_type top-(diversity_per_type=2), same dedupe_key 클러스터 1개만
Stage 8  weighted score (§8 공식) + sort desc + take top_n
```

- [ ] **Step 1: Write test (각 stage 별 fixture 케이스)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { runRetrieve } = require('../scripts/retrieve');
// 케이스:
// (a) 8 cards in FTS5, 2 deprecated → Stage 1 drops 2, Stage 2 normalizes over 6.
// (b) zero matches → returns { memories: [] } (no error)
// (c) all-stale (review_after past) → returns with stale warning, Stage 8 keeps them with penalty
// (d) missing-profile → project_sim=0 enforced, warning in payload
// (e) applicability guard: task='use Codex slash' AND card has non_applicability='Claude Code slash-command-only plugin' → drop
// (f) diversity: 5 failure-case with same dedupe_key → only 1 in result
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement retrieve.js** (uses fts-index + score.js per stage order above; reads cards from `cards/<type>/{global, project_id}/*.json` for full payload)

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/retrieve.js tests/retrieve-ranking.test.js
git commit -m "feat(phase-4): scripts/retrieve.js — 6-stage ranking with explicit order (P16)"
```

### Task 4.4: Brief output (JSON + MD) — `lib/brief-format.js`

**Files:**
- Create: `scripts/lib/brief-format.js`
- Test: `tests/brief-format.test.js`

- [ ] **Step 1: Test (avoid_when mapping + fallback defaults + why_relevant 비어있을 때 default)**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { renderJson, renderMarkdown, DEFAULTS } = require('../scripts/lib/brief-format');

test('avoid_when maps from non_applicability[].value', () => {
  const card = { payload: { non_applicability: [{ value: 'X', source_id: 'src_0', confidence: 0.8 }], claim: 'c', recommended_action: ['a'], memory_id: 'm', memory_type: 'failure-case' }, envelope: { provenance: { source_artifacts: [{ path: 'p' }] } } };
  const out = renderJson('task', [card], { score: 0.7, why_relevant: 'tag match' });
  assert.deepStrictEqual(out.payload.memories[0].avoid_when, ['X']);
});

test('per-card fallback for empty non_applicability', () => {
  const card = { payload: { non_applicability: [], claim: 'c', recommended_action: [], memory_id: 'm', memory_type: 'pattern' }, envelope: { provenance: { source_artifacts: [{ path: 'p' }] } } };
  const out = renderJson('task', [card]);
  assert.deepStrictEqual(out.payload.memories[0].avoid_when, [DEFAULTS.avoid_when]);
});

test('markdown rendering includes fallback "(none specified)"', () => {
  // similar
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** (uses §9.2 spec — DEFAULTS = { why_relevant: '(retrieved by lexical match)', avoid_when: '(none specified)', recommended_action: '(none — refer to evidence)' })

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/brief-format.js tests/brief-format.test.js
git commit -m "feat(phase-4): brief-format.js — JSON+MD render with avoid_when mapping + per-card fallback (F2)"
```

### Task 4.5: `scripts/brief.js` (skill entry point)

**Files:**
- Create: `scripts/brief.js`
- Test: `tests/brief.test.js`

- [ ] **Step 1: Test** (orchestrates retrieve + brief-format, writes `.deep-memory/latest-brief.{json,md}` atomic)

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../scripts/brief');

test('brief.run writes JSON + MD atomically', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-brief-proj-'));
  // ... (setup memory_root + at least 1 card)
  await run({ task: 'implement Codex plugin manifest', projectDir, memoryRoot: '...' });
  assert.ok(fs.existsSync(path.join(projectDir, '.deep-memory/latest-brief.json')));
  assert.ok(fs.existsSync(path.join(projectDir, '.deep-memory/latest-brief.md')));
});
```

- [ ] **Step 2-4: Implement + run + commit** (1 file: orchestration only, all logic in retrieve.js + brief-format.js)

```bash
git add scripts/brief.js tests/brief.test.js
git commit -m "feat(phase-4): scripts/brief.js — skill entry orchestrating retrieve + brief-format"
```

### Task 4.6 (NEW, P17): Cross-reference invariant test — applicability.source_id → provenance.source_artifacts[].id

**Files:**
- Create: `tests/cross-ref-invariant.test.js`

- [ ] **Step 1: Write test**

```javascript
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { glob } = require('node:fs');  // or readdirSync recursive

function* allCardFiles(root) {
  if (!fs.existsSync(root)) return;
  for (const type of fs.readdirSync(root)) {
    const td = path.join(root, type);
    if (!fs.statSync(td).isDirectory()) continue;
    for (const scope of fs.readdirSync(td)) {  // global | <project_id>
      const sd = path.join(td, scope);
      if (!fs.statSync(sd).isDirectory()) continue;
      for (const f of fs.readdirSync(sd)) {
        if (f.endsWith('.json')) yield path.join(sd, f);
      }
    }
  }
}

test('every applicability/non_applicability.source_id resolves into envelope.provenance.source_artifacts[].id', () => {
  const memoryRoot = process.env.DEEP_MEMORY_TEST_ROOT || path.join(require('os').tmpdir(), 'no-cards-here');
  const cardsRoot = path.join(memoryRoot, 'cards');
  for (const cardPath of allCardFiles(cardsRoot)) {
    const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    const validIds = new Set((card.envelope?.provenance?.source_artifacts || []).map((s) => s.id));
    for (const a of [...(card.payload?.applicability || []), ...(card.payload?.non_applicability || [])]) {
      assert.ok(validIds.has(a.source_id), `${cardPath}: source_id ${a.source_id} not in provenance`);
    }
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/cross-ref-invariant.test.js
git commit -m "test(phase-4): cross-reference invariant — applicability.source_id ↔ provenance.id (P17)"
```

---

## Phase 5 — Audit (2일 — P2 expand + P29 re-estimate)

목표: `deep-memory-audit` skill + `audit.js` (schema validate + 3-pass redaction sample + stale memory + stale lock + dedupe collision + source-rename + profile freshness + `--unlock` + `--promote <id>`). **P2 fix — 각 sub-feature 마다 독립 task** (이전 one-liner 압축은 implementer 의 design 재도출 위험).

### Task 5.0: `skills/deep-memory-audit/SKILL.md`

**Files:**
- Create: `skills/deep-memory-audit/SKILL.md`

frontmatter description ≤1024 char + strict YAML. body 는 4개 sub-command (`(empty)` / `--unlock` / `--promote <id>` / `--rebuild-index`) 분기 안내 + 각 sub-feature 가 `audit.js` 의 어느 함수 호출인지 명시. Commit `feat(phase-5): skills/deep-memory-audit/SKILL.md (4 sub-commands)`.

### Task 5.1: Schema validation pass (Ajv on all cards)

**Files:**
- Create: `scripts/audit.js` (skeleton + `validateAllCards()`)
- Test: `tests/audit-schema-validate.test.js`

- [ ] **Step 1: Test** — populate memory_root with 2 valid card + 1 invalid (missing required field) → audit reports 1 invalid.
- [ ] **Step 2-4: Implement using Ajv (read memory-card.schema.json) + walk `cards/<type>/{global,project_id}/*.json` + collect violations + commit**

### Task 5.2: Stale memory detect + state machine apply

**Files:**
- Modify: `scripts/audit.js` (add `applyAutoTransitions()`)
- Test: `tests/audit-stale-memory.test.js`

- [ ] **Step 1: Test** — card with past `review_after` + status=validated → after audit, status=deprecated + status_history grew by 1.
- [ ] **Step 2-4: Implement** uses `state-machine.evaluateTransitions({...card, trimHistory: true})` per card + atomic rewrite via `writeJsonAtomic` (P8 fix applied here too) + commit.

### Task 5.3: Stale lock detect + `--unlock`

**Files:**
- Modify: `scripts/audit.js` (`detectStaleLocks()` + `unlock()`)
- Test: `tests/audit-stale-lock.test.js`

- [ ] **Step 1: Test** — create lock dir with `created_at` 6 minutes ago → audit detects → `--unlock` removes + reports.
- [ ] **Step 2-4: Implement** uses `lock.isStale(meta)` + `lock.breakLock(lockPath)` + commit.

### Task 5.4: dedupe collision report (spec §6.4)

**Files:**
- Modify: `scripts/audit.js` (`detectDedupeCollisions()`)
- Test: `tests/audit-dedupe-collision.test.js`

- [ ] **Step 1: Test** — 2 cards with same `dedupe_key` but contradicting `applicability` arrays (different `source_id` values) → audit reports as `applicability_contradiction`.
- [ ] **Step 2-4: Implement** uses spec §6.4 의 conflict resolution policy + commit.

### Task 5.5: source-rename detect (content_hash 검증)

**Files:**
- Modify: `scripts/audit.js` (`detectSourceRenames()`)
- Test: `tests/audit-source-rename.test.js`

- [ ] **Step 1: Test** — card 가 reference 하는 source artifact 의 hash가 현재 디스크 file 의 hash 와 다름 → audit reports `unresolved_source` with old + current hashes.
- [ ] **Step 2-4: Implement** uses `source-hash.hashFile()` + commit.

### Task 5.6: profile freshness check (`audit.profile_max_age_days`)

**Files:**
- Modify: `scripts/audit.js` (`detectStaleProfile()`)
- Test: `tests/audit-profile-freshness.test.js`

- [ ] **Step 1: Test** — `.deep-memory/project-profile.json` 의 `generated_at` 이 31일 이전 → audit warns + suggests `/deep-memory-init` 재실행.
- [ ] **Step 2-4: Implement** + commit.

### Task 5.7: `--promote <id>` (atomic move local → global, harvest lock 과 인터랙션)

**Files:**
- Modify: `scripts/audit.js` (`promoteCard()`)
- Test: `tests/audit-promote.test.js`

> **P8 fix interaction (lock 보호)**: `--promote` 가 atomic move 를 수행하는 동안 harvest 가 같은 카드의 `dedupe_key` 충돌 검사로 양쪽 디렉토리를 union scan 한다 (Task 2.5 의 §7.3 step 4 fix). 따라서 promote 도 같은 global lock 안에서 수행.

- [ ] **Step 1: Test** — `--promote mem_xxx` 호출 → (a) global lock acquire → (b) card 의 `privacy_level: local → global` → (c) atomic move from `cards/<type>/<project_id>/` to `cards/<type>/global/` → (d) status_history append → (e) FTS5 upsert (project_id 비움) → (f) global lock release.
- [ ] **Step 1.a (R3 fix): Additional test — concurrent harvest×promote serialization** (`tests/audit-promote-vs-harvest.test.js`)

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { harvestArtifact } = require('../scripts/harvest');
const { promoteCard } = require('../scripts/audit');

test('concurrent harvest + promote do not corrupt directories', async () => {
  const tmp = /* ... setup memory_root with 1 local card */;
  await Promise.all([
    harvestArtifact({ /* ... */ }),
    promoteCard('mem_target', { memoryRoot: tmp }),
  ]);
  // Verify: card is in exactly one location (global OR local, not both not neither), FTS5 has 1 row
  assert.ok(/* ... */);
});
```

- [ ] **Step 2-4: Implement** with explicit lock acquire (`lock.acquire(lockPath, {operation: 'promote'})`) — fails with `LOCK_HELD` if harvest 중. + commit.

```bash
git add scripts/audit.js tests/audit-*.test.js
git commit -m "feat(phase-5): Task 5.7 --promote with global lock interaction (P9 lock-aware)"
```

### Task 5.8: Audit aggregated runner + CLI entry

**Files:**
- Modify: `scripts/audit.js` (top-level `run()` orchestrator)

- [ ] **Step 1**: Aggregate all 7 sub-results → `.deep-memory/latest-audit.json` (atomic write) → console summary.
- [ ] **Step 2**: `if (require.main === module)` CLI entry: argv parse → call right sub-function (`(empty)` / `--unlock` / `--promote <id>` / `--rebuild-index`).
- [ ] **Step 3-4**: Test full end-to-end + commit.

---

## Phase 6 — Tests + CI (1.5일)

목표: 모든 test 통합 + `npm test` 녹색 + manifest-drift CI workflow.

### Task 6.1: Aggregated test entry

**Files:**
- Modify: `package.json` test script

- [ ] **Step 1: Run all tests**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory && npm test
```
Expected: all suites PASS.

### Task 6.2: GitHub Actions CI workflow (P5 fix — full YAML literal, not placeholder)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/.github/workflows/ci.yml`

- [ ] **Step 1: Write workflow YAML**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22]
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - name: Install dependencies
        run: npm ci --no-audit --no-fund
      - name: Verify manifests (3중 version 동기 + Codex 1024-char + strict YAML)
        run: npm run validate-manifest
      - name: Run tests
        run: npm test

  manifest-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node 22
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci --no-audit --no-fund
      - name: Manifest-drift test only
        run: node --test tests/manifest-drift.test.js
```

- [ ] **Step 2: Validate YAML syntax locally**

```bash
node -e "const y = require('js-yaml'); y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('OK')"
```
Expected: `OK` (requires js-yaml installed; or skip locally — GitHub will validate).

- [ ] **Step 3: Commit** (do NOT push without user consent)

```bash
git add .github/workflows/ci.yml
git commit -m "ci(phase-6): GitHub Actions workflow — Node 22 + npm test + manifest-drift gate"
```

---

## Phase 7 — Suite integration (0.5일) — P6 fix: 명시적 cross-repo cwd protocol

> ⚠️ **Cross-repo cwd invariant**: Phase 7 의 모든 task 는 별도 git repo (`/Users/sungmin/Dev/claude-plugins/deep-suite/`) 를 수정한다. **모든 task 시작 시 `cd` 명시 + 종료 시 `cd -` 복귀**. commit 도 그 repo 안에서. 잘못된 cwd 에서 `git add/commit` 하면 silent failure 또는 다른 repo 에 잘못 기록.

### Task 7.0 (사전 안전): deep-suite repo clean check

- [ ] **Step 1: Cross-repo cwd preflight**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
git status --short  # expect empty (no in-progress work in sibling repo)
git rev-parse --show-toplevel  # confirm we are in the right repo
cd -
```
Expected: `git status --short` 결과 empty + `rev-parse` 가 deep-suite 절대경로 출력.

### Task 7.1: Add deep-memory entry to `deep-suite/.claude-plugin/marketplace.json` + automate via `scripts/sync-suite.js` (P20)

**Files** (in `deep-suite/` repo):
- Modify: `/Users/sungmin/Dev/claude-plugins/deep-suite/.claude-plugin/marketplace.json`

또한 자동화를 위해 `deep-memory/scripts/sync-suite.js` 도 작성 (P20). 본 Task 는 entry append + sync-suite.js step.

> R3 fix — sync-suite.js 작성은 Task 7.5 의 단독 책임. Task 7.1 은 first-release 의 manual entry 만.

- [ ] **Step 1 (cwd = deep-suite): Edit marketplace.json**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
# Manual edit: append deep-memory block under "plugins": [...]
# Use Edit tool, NOT in-place sed (preserves formatting)
```

JSON shape (insert as last array entry):
```json
{
  "name": "deep-memory",
  "description": "Cross-project semantic operational memory — harvests deep-suite artifacts (recurring-findings/evolve-insights/session-receipts/docs-scan/wiki-index), distills reusable memory cards via hybrid rule+LLM, injects task-specific briefs. 4 skill entry surfaces (Claude Code + Codex + Copilot + Gemini). M3 envelope-wrapped, 3-pass redaction, atomic write + mkdir lock + project lease, privacy_level local|global with explicit --promote gate.",
  "source": {
    "source": "url",
    "url": "https://github.com/Sungmin-Cho/claude-deep-memory.git",
    "sha": "<pinned-sha-after-first-release>"
  }
}
```

- [ ] **Step 2 (cwd = deep-suite): Validate JSON + commit in deep-suite repo**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8'))" && echo OK
git status --short
git diff .claude-plugin/marketplace.json
git add .claude-plugin/marketplace.json
git commit -m "chore: add deep-memory v0.1.0 to marketplace (Claude Code)"
cd -
```

### Task 7.2: Add to `deep-suite/.agents/plugins/marketplace.json` (Codex)

Same pattern as 7.1 (cd into deep-suite, edit, validate, commit), with the entry:
```json
{
  "name": "deep-memory",
  "source": { "source": "url", "url": "https://github.com/Sungmin-Cho/claude-deep-memory.git", "sha": "<pinned-sha>" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
  "category": "Productivity"
}
```

Commit (in deep-suite repo): `chore: add deep-memory v0.1.0 to marketplace (Codex)`

### Task 7.3: Add to `deep-suite/.claude-plugin/suite-extensions.json` (sidecar)

Append deep-memory section from spec §10.3 + 4 data_flow edges from spec §10.4. Same cwd protocol.

Commit (in deep-suite repo): `chore: add deep-memory v0.1.0 to suite-extensions sidecar`

### Task 7.4: Update `deep-suite/README.md` + `README.ko.md` plugin table

Same cwd protocol. Add a row + a `## deep-memory` section. Commit message: `docs: add deep-memory v0.1.0 to README (en + ko)`.

### Task 7.5: `scripts/sync-suite.js` (in deep-memory repo) — automate Task 7.1-7.4 for future releases (P20)

**Files:**
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/scripts/sync-suite.js`

Reads `package.json` version + given `SUITE_REPO` env (default `/Users/sungmin/Dev/claude-plugins/deep-suite`) + computes sha (from `git rev-parse HEAD`), and atomically updates the 3 sibling files in deep-suite via library calls. Used by `npm run sync-suite` for v0.2.0+ releases.

- [ ] **Step 1-5**: full TDD — test asserts the resulting marketplace.json contains a deep-memory entry with correct sha; sync-suite.js implementation uses Edit-like JSON manipulation; commit `feat: scripts/sync-suite.js — automate suite-marketplace updates (P20)`.

---

## Phase 8 — Handoff docs + spec finalize (0.5일) — P6 fix: 명시적 cwd protocol

### Task 8.1: `docs/handoff-phase-4-6.md` (deep-memory 자체 후속, in this repo)

**Files** (cwd = deep-memory repo):
- Create: `/Users/sungmin/Dev/claude-plugins/deep-memory/docs/handoff-phase-4-6.md`

Content from spec §14.1 (Phase 4 review/evolve writer integration / Phase 5 reasoning graph / Phase 6 dashboard telemetry + closing checklist + out-of-scope) + R3 학습 (false confidence — 외부 리뷰 1명 이상이 plan 진입 전 필수).

Commit (in deep-memory repo): `docs(phase-8): handoff-phase-4-6.md (decay/graph/dashboard scopes)`

### Task 8.2: `/Users/sungmin/Dev/claude-plugins/deep-work/docs/deep-memory-integration-handoff.md` (CROSS-REPO)

> ⚠️ **Different repo**. Same cwd discipline as Phase 7.

- [ ] **Step 0 (cross-repo cwd preflight)**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-work
git status --short  # expect empty
git rev-parse --show-toplevel  # confirm deep-work repo
cd -
```

- [ ] **Step 1 (cwd = deep-work): Create handoff file**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-work
mkdir -p docs
# Create docs/deep-memory-integration-handoff.md with content from spec §14.2:
#  1. deep-work 현재 상태 (deep-memory 와 분리 운영)
#  2. Phase 1 Research 진입 시 .deep-memory/latest-brief.md 자동 인용
#  3. Phase 5 Integrate top-3 후보에 /deep-memory-harvest 추가
#  4. Research artifact schema 확장
#  5. Feedback hook (Phase 4+ 양쪽 동시 도입)
#  6. Test: deep-work이 brief 없이도 정상 동작 + brief 있으면 인용
```

- [ ] **Step 2 (cwd = deep-work): Commit in deep-work repo**

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-work
git add docs/deep-memory-integration-handoff.md
git status --short  # verify only the handoff file is staged
git commit -m "docs: add deep-memory-integration-handoff (consumer-side spec)"
cd -
```

### Task 8.3: Spec finalize (in deep-memory repo, conditional)

만약 implementation 중 spec drift 발견되면 spec doc 수정 + commit. Spec 변경 없으면 skip.

---

## Self-Review (Round 2 — plan-review 반영 후 갱신)

**Round 1 deep-review-loop 결과 적용** (2026-05-20T13:57:37):
- 4-way 독립 리뷰 (Opus / Codex review / Codex adversarial / agy) — 만장일치 REQUEST_CHANGES, 21🔴 + 20🟡 + 3ℹ️ → dedupe 후 29 항목
- 적용 범위: 옵션 C (P1-P28 + P29 schedule re-estimate)
- 핵심 회귀: plan 의 이전 Self-Review §1 "spec coverage 100%" 주장이 false confidence — Phase 3a (5 mapper) + Phase 5 (7 sub-feature) + Phase 4 가 outline 만, harvest.js 가 lock+lease+events 미통합인데 retrofit task 부재.

**Round 2 후 plan 상태**:

### 1. Spec coverage (재검증)

| Spec section | Plan task |
|---|---|
| §1 Decisions (D1-D20) | 모두 Phase 0~8 의 결정으로 반영 |
| §3 Directory layout | Phase 0 + 각 lib/script Task |
| §4 Manifests | Task 0.1, 0.2 |
| §5 Skill surface | Task 2.1, 2.3, 4.1, 5.0 |
| §6 Card schema | Task 1.0a (envelope compat probe), 1.1, 1.2 |
| §6.2 dedupe (보수화 + cross-type) | Task 1.5 + 5.4 (collision report) |
| §6.3 state machine | Task 1.6, 5.2 |
| §6.4 conflict resolution | Task 5.4 (collision audit) |
| §7.1 Step A 5 types | Task 2.4 + 3a.1-5 (각 mapper 독립 task — P2 fix) |
| §7.2 Step B + 4 adapter + schema validation | Task 1.12, 3b.1-7 + P14 adapter allowlist |
| §7.3 lease + lock + atomic + idempotent + FTS5 commit | Task 1.7, 1.8, **2.5 (신규, P3 fix)**, 5.7 (promote interaction) |
| §8 retrieval 정규화 + degraded paths | Task 1.10 (P13 BM25 invert), 4.3 (P16 stage order) |
| §9 brief output (avoid_when mapping + per-card fallback) | Task 4.4 (F2 fix) |
| §10 cross-plugin + config + suite-extensions | Task 2.2 (config.yaml), 7.1-3 (cwd protocol P6 fix), **7.5 sync-suite.js (P20 fix)** |
| §11 3-pass redaction + suppressions + metadata | Task 1.4 (Pass 1), 3b.6 (Pass 2/3 — P1 fix), 5.x (audit metadata) |
| §12 test suites (12 + 3 new) | 각 Task TDD step 2 + Task 4.6 cross-ref (P17) + tests/runtime-contract/ (F12) |
| §13 CLAUDE.md / AGENTS.md | Task 0.5, 0.6 |
| §14 handoff docs | Task 8.1, 8.2 (cwd protocol P6 fix) |
| §15 phases | 본 plan 의 Phase 0-8 |

**R1 review 로 추가된 task** (이전 plan 의 gap 닫음):
- **Task 1.0a** (P11): suite M3 envelope compat probe — `provenance.source_artifacts[]` 가 deep-memory-specific 필드 받아들일지 사전 확인
- **Task 2.5** (P3): harvest.js lease + lock + idempotent events + FTS5 upsert retrofit (이전 "simplified for Phase 2" comment 가 가리킨 gap)
- **Task 4.6** (P17): cross-reference invariant test (applicability.source_id ↔ provenance.source_artifacts[].id)
- **Task 5.0** (P2): deep-memory-audit skill 명시
- **Task 5.1-5.8** (P2): 7 sub-feature 마다 독립 task (이전 one-liner 압축에서 expand)
- **Task 7.0** (P6): cross-repo cwd preflight
- **Task 7.5** (P20): sync-suite.js 자동화 (manual sync 위험 제거)

### 2. Placeholder scan (재검증)

- "TBD" / "TODO" / "implement later": 0 매치
- "Similar to Task N": Phase 3a 5 task 가 각각 독립 expand 됨 (P2 fix). 잔여 사용은 fixture 구조 같은 trivial parallel only (e.g., Phase 7.2 의 "Same pattern as 7.1" — 단 entry JSON shape 만 다름, cwd protocol 동일).
- Task 6.2 CI YAML — full literal inline (P5 fix). 더 이상 "Write workflow" placeholder 없음.
- Task 3b.6 — `require('./lib/llm-bridge')` real import (P1 fix). literal 'placeholder' 제거.

### 3. Type/method consistency (재검증)

- `wrap()` envelope: Task 1.3 정의 → Task 2.4 + 3b.6 + 2.5 사용 ✓
- `dedupeKey(memoryType, claim, applicability)` : Task 1.5 정의 → Task 2.4 + 5.4 사용 ✓
- `acquire(lockPath, {operation})` / `release(handle)` / `StaleLockError`: Task 1.7 정의 → Task 2.5 + 5.3/5.7 사용 ✓ (P9 typed error)
- `writeJsonAtomic(target, data)`: Task 1.8 정의 → 모든 persist 사용 ✓ (P8 fsync 순서 fix)
- `refine(eventDraft, sourceExcerpt, opts)` (signature with `...adapterOpts`): Task 1.12 (Phase 1 skeleton 도 같은 sig — P15 fix) + 3b.5 (schema validation 추가) → Task 3b.6 사용 ✓
- `harvestArtifact({...})`: Task 2.4 정의 → Phase 3a 확장 + Task 2.5 persist 통합 ✓
- `openIndex(filepath)` / `upsertCard(idx, card, {projectId})` / `search(idx, query, {topN, projectId})`: Task 4.2 정의 (P12 shape + P7 hard-dep better-sqlite3 — R3 fix: sql.js fallback 은 v0.1.0 out-of-scope, handoff-phase-4-6 이연) → Task 2.5 + 4.3 + 5.7 사용 ✓
- `bm25MinMax(rows)` (P13 invert): Task 1.10 정의 → Task 4.3 stage 2 사용 ✓

→ R2 모든 변경 후 consistent.

### 4. New decisions (Round 2 plan-review 반영)

| ID | 결정 |
|---|---|
| PR1 | Task 1.0a — Phase 0 단계에서 suite envelope schema compat 사전 확인 후 Task 1.1 schema 작성 시 분기 |
| PR2 | StaleLockError 타입 도입 (P9) — outer catch 가 swallow 안 함 |
| PR3 | atomic-write 의 fsync 순서: tmp write → fsync(tmp) → rename → fsync(parentDir) → readback (P8) |
| PR4 | bm25MinMax 정규화 방향 INVERT: `(max - raw) / (max - min)` (P13) |
| PR5 | llm-bridge adapter dispatch: allowlist map (P14) — require() path 에 user-controlled 값 사용 안 함 |
| PR6 | claude-agent adapter: 모든 throw 가 typed `ADAPTER_NOT_WIRED` code → harvest 가 graceful candidate fallback (P4) |
| PR7 | Cross-repo task (Phase 7, 8.2): `cd` + `git status --short` preflight + repo-local commit + `cd -` 복귀 명시 (P6) |
| PR8 | sync-suite.js 자동화 (Task 7.5) — v0.2.0+ 의 marketplace.json drift 위험 차단 (P20) |

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-deep-memory-v0.1.0.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. 50+ task 단위가 적합. Each subagent gets `task_id` + plan section, runs TDD, returns.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. 단일 컨텍스트라 변수 추적 쉬움; 다만 50+ task 누적으로 context 부담 큼.

**Which approach?**
