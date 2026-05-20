# deep-memory v0.1.0 — Design Spec

작성일: 2026-05-20
상태: draft (사용자 리뷰 대기)
저자: brainstorming 세션 (Claude Opus 4.7)
기반 문서: [`deep-suite-cross-project-semantic-operational-memory-proposal.md`](../../deep-suite-cross-project-semantic-operational-memory-proposal.md)

---

## 0. Scope summary

deep-suite의 7번째 플러그인 `deep-memory`의 **v0.1.0 (MVP)** 설계. 제안서 §15 Phase 0~3 (skeleton + harvest + distill + brief) 까지 구현하고, Phase 4~6 (review/evolve writer integration / reasoning graph / dashboard telemetry) 은 별도 handoff 문서로 인계.

본 spec의 implementation은 후속 `writing-plans` 단계에서 step-by-step plan으로 분해된다.

---

## 1. Decisions log

다음 결정은 brainstorming 세션 (2026-05-20) 에서 사용자와 합의된 사항이다. spec 작성 시점부터 implementation 진입 전까지 변경하려면 사용자 승인 필요.

| # | 결정 | 근거 |
|---|---|---|
| D1 | MVP 범위 = Phase 0+1+2+3, Phase 4~6은 handoff 문서로 인계 | 사용자 선택 |
| D2 | Distill 전략 = Hybrid (rule-based Step A + LLM sub-agent Step B + fallback Step C) | 사용자 선택 |
| D3 | Runtime = Node 22 + bash | 형제 6개 플러그인과 동일 |
| D4 | `memory_root` 기본값 = `~/.deep-memory/` (env `DEEP_MEMORY_ROOT` override) | 사용자 보정 — Claude-specific path 회피 |
| D5 | Skill surface = 4 entry (init/harvest/brief/audit) + 1 reference (`memory-schema`) | Codex 1024-char description 한계 회피 + cognitive load |
| D6 | distill을 별도 skill로 노출하지 않고 harvest 내부 Step B로 통합 | skill 수 최소화 + UX 단순화 |
| D7 | Lock 정책 = mkdir-based | deep-wiki와 동일, suite 내 검증된 패턴 |
| D8 | MVP 임베딩 제외 = sqlite FTS5 lexical only | scope creep 방지 (Phase 4+ 이연) |
| D9 | semantic dedupe 제외 = `dedupe_key` (sha256(type+normalize(claim))) 정확 일치만 | MVP 결정성 우선 |
| D10 | Privacy MVP = rule-based 1-pass redaction + `suppressions.yaml` + CI invariant test | LLM second-pass는 Phase 4+ |
| D11 | Cross-plugin contract = read-only consumer만, 다른 플러그인 코드 변경 0 | privacy / trust boundary / 릴리스 독립성 |
| D12 | deep-work brief 활용 = 사용자가 적절히 판단 (별도 deep-work handoff 문서 작성) | MVP는 deep-memory 측만 |
| D13 | CLAUDE.md ~2KB, AGENTS.md ~1KB | 사용자 명시 "짧게" 우선, 형제 분량 (CLAUDE.md 14KB) 의도적으로 따르지 않음 |
| D14 | Implementation = 10단계 ~12.5 영업일 (R1 review 반영: Phase 3 분리 + atomic/lock/preflight/bridge 추가) | brainstorming 합의 + R1 F14 |
| D15 | `privacy_level: local \| global` per-card 필드 + global promote 는 audit 명시 호출만 | R1 F9 — regex 1건 실패가 모든 미래 프로젝트 leak 막기 |
| D16 | sqlite = `better-sqlite3` (native) **pin**, Phase 0 install probe + `sql.js` (WASM) fallback 분기 | R1 F13 — Q2 deferred 였던 항목 spec 으로 승격 |
| D17 | redaction = 3-pass (Step A input / Step B input / envelope wrap 직전) | R1 F6 — Step B 가 LLM 호스트에 raw token leak 위험 |
| D18 | atomic write = temp+fsync(file)+fsync(dir)+rename 의무. lock dir 에 `{pid, host, created_at}` metadata + stale detect (>5min) | R1 F3 — partial file + 영구 lock 차단 |
| D19 | distill LLM adapter = `scripts/lib/llm-bridge.js` 추상화 (auto / claude-agent / codex-bash / gemini-sdk / stdin-fallback) + runtime contract tests | R1 F11/F12 — cross-runtime silent regression 차단 |
| D20 | bash → Node 마이그레이션: `scripts/lock.sh` 폐기, `scripts/lib/lock.js` 로 (Windows portability) | R1 F24 |

---

## 2. Architecture

```text
┌────────────────────────────────────────────────────────────────┐
│  Cross-runtime entry surfaces                                   │
│  Claude Code: /deep-memory-{init,harvest,brief,audit}           │
│  Codex / Copilot / Gemini / SDK: Skill({skill:"deep-memory:…"}) │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  skills/deep-memory-{init,harvest,brief,audit}/SKILL.md         │
│  + skills/memory-schema/SKILL.md  (reference, non-invocable)    │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  scripts/ (Node + bash)                                         │
│  - harvest.js  (rule-based field mapping → events JSONL)        │
│  - distill.js  (hybrid: rule extract → LLM refine fields)       │
│  - retrieve.js (lexical FTS5 ranking → brief)                   │
│  - audit.js    (schema validation + redaction check + freshness)│
│  - lock.sh     (mkdir-based, suite 표준)                        │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  Storage (M3 envelope-wrapped)                                  │
│  Project-local: .deep-memory/                                   │
│  Global:        ~/.deep-memory/                                 │
└────────────────────────────────────────────────────────────────┘
```

핵심 원칙:
- **M3 envelope 재사용** — 새 schema 만들지 않고 deep-suite/schemas/artifact-envelope.schema.json 그대로 사용. `producer = "deep-memory"`.
- **MVP는 read-only consumer** — 다른 플러그인 코드 변경 0. harvest는 다른 플러그인이 이미 emit한 artifact만 읽음.
- **Distill = hybrid** — rule-based로 결정적 필드 채우고, LLM은 빈 필드만 refine. host LLM 실패 시 candidate status로 graceful degrade.

---

## 3. Directory layout

```text
deep-memory/
├── .claude-plugin/
│   └── plugin.json                # Claude Code manifest (minimal)
├── .codex-plugin/
│   └── plugin.json                # Codex manifest (rich)
├── .gitignore
├── AGENTS.md                       # ~1KB
├── CHANGELOG.md
├── CHANGELOG.ko.md
├── CLAUDE.md                       # ~2KB
├── LICENSE                         # MIT
├── README.md
├── README.ko.md
├── package.json                    # private:true, node --test
├── agents/
│   └── memory-distiller.md         # sub-agent (Write 없음, Read 가능)
├── docs/
│   ├── deep-suite-cross-project-semantic-operational-memory-proposal.md  # 기존
│   ├── handoff-phase-4-6.md        # deep-memory 후속 작업 인계
│   └── superpowers/specs/
│       └── 2026-05-20-deep-memory-design.md  # 본 spec
├── schemas/
│   ├── memory-card.schema.json
│   ├── memory-event.schema.json
│   └── project-profile.schema.json
├── scripts/
│   ├── harvest.js
│   ├── distill.js
│   ├── retrieve.js
│   ├── audit.js
│   ├── lib/
│   │   ├── envelope.js             # M3 wrap (deep-suite/schemas 호환)
│   │   ├── redact.js               # rule-based 3-pass redaction (D17)
│   │   ├── dedupe.js               # claim normalize (보수화) + sha256
│   │   ├── state-machine.js        # status 전이 (4 자동 + 1 수동)
│   │   ├── lock.js                 # Node mkdir-based + metadata + stale detect (D18, D20)
│   │   ├── llm-bridge.js           # cross-runtime adapter (D19)
│   │   ├── atomic-write.js         # temp+fsync(file)+fsync(dir)+rename (D18)
│   │   ├── source-hash.js          # source_artifact content hash (F8)
│   │   ├── score.js                # 0-1 정규화 score (F7)
│   │   ├── preflight.js            # realpath/writability/NFS/sqlite probe (F10)
│   │   └── adapter-registry.js     # adapter detection + selection (D19)
├── skills/
│   ├── deep-memory-init/SKILL.md
│   ├── deep-memory-harvest/SKILL.md
│   ├── deep-memory-brief/SKILL.md
│   ├── deep-memory-audit/SKILL.md
│   └── memory-schema/SKILL.md      # user-invocable:false (reference)
└── tests/
    ├── envelope-emit.test.js
    ├── harvest-golden.test.js
    ├── distill-golden.test.js      # LLM Step B는 mock
    ├── redaction.test.js           # 3-pass (Step A in / Step B in / wrap 직전) + known-secret invariant
    ├── dedupe.test.js              # cross-type 충돌 회피 케이스 포함 (F22)
    ├── state-machine.test.js
    ├── manifest-drift.test.js      # 3중 version 동기 + Codex 1024-char + strict YAML 검증 (F23)
    ├── atomic-write.test.js        # partial-write 시뮬레이션 (F3)
    ├── lock.test.js                # stale lock detect + recover (F3)
    ├── score-normalization.test.js # 0-1 정규화 + zero/all-stale/missing-profile 거동 (F7)
    ├── concurrent-harvest.test.js  # 2 세션 race + idempotency (F4)
    ├── source-hash.test.js         # source artifact rename/delete 후 provenance (F8)
    ├── runtime-contract/           # F12 — adapter 별 smoke fixture
    │   ├── claude-adapter.test.js
    │   ├── codex-adapter.test.js
    │   └── stdin-fallback.test.js
    └── fixtures/
        ├── sample-recurring-findings.json
        ├── sample-evolve-insights.json
        ├── sample-session-receipt.json
        ├── dangerous-secrets.json
        ├── runtime-recorded/        # adapter 별 recorded golden response
        │   ├── claude-agent.jsonl
        │   ├── codex-bash.jsonl
        │   └── stdin-fallback.jsonl
        └── golden-cards/*.json
```

global memory_root (`~/.deep-memory/`) 의 추가 디렉토리:

```text
~/.deep-memory/
├── config.yaml
├── projects/                       # F19 — project-profile 의 global 복제 (cross-project similarity 비교용)
│   └── <project_id>.json
├── .leases/                        # F4 — project 단위 harvest lease (race 방지)
│   └── <project_id>.lease
├── .lock/                          # D18 — mkdir-based + {pid, host, created_at} metadata
├── events/
│   ├── YYYY-MM.jsonl
│   └── transitions-YYYY-MM.jsonl   # F20 — status_history 의 외부 audit log
├── cards/
│   └── <type>/
│       ├── global/<memory_id>.json # D15 — promote 된 카드만
│       └── <project_id>/<memory_id>.json  # D15 — 기본 (local)
└── indexes/
    └── lexical.sqlite
```

생성 작업이 추가로 별도 위치에 다음 파일을 생성:
- `/Users/sungmin/Dev/claude-plugins/deep-work/docs/deep-memory-integration-handoff.md` (deep-work 측 후속 작업 명세)
- `/Users/sungmin/Dev/claude-plugins/deep-suite/.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json` + `.claude-plugin/suite-extensions.json` (entry 추가)

---

## 4. Manifests

### 4.1 `.claude-plugin/plugin.json` (Claude Code, 미니멀)

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

### 4.2 `.codex-plugin/plugin.json` (Codex, interface 포함)

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

> repository URL은 실제 GitHub repo 생성 시 사용자가 정정. v0.1.0 릴리스 전 placeholder.

### 4.3 `package.json`

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
    "test": "node --test tests/envelope-emit.test.js tests/harvest-golden.test.js tests/distill-golden.test.js tests/redaction.test.js tests/dedupe.test.js tests/state-machine.test.js tests/manifest-drift.test.js"
  }
}
```

---

## 5. Skill surface

| Skill | user-invocable | 역할 | 입력 | 산출 |
|---|---|---|---|---|
| `deep-memory-init` | true | `memory_root` 결정 + preflight (realpath/writability/NFS/sqlite probe, F10) + `config.yaml` schema validation + `~/.deep-memory/projects/<project_id>.json` + project-local `.deep-memory/project-profile.json` 양쪽 생성 | 없음 (auto-detect) 또는 `<memory_root>`, optional `--allow-network-root` | `~/.deep-memory/config.yaml` (atomic write, schema-validated), `.deep-memory/project-profile.json`, `~/.deep-memory/projects/<project_id>.json` |
| `deep-memory-harvest` | true | project artifact 스캔 → events JSONL → distill (Step A + Step B + 3-pass redaction) → cards 저장. lease 획득 (F4), atomic write (F3), source content_hash (F8) | 없음 (전체) 또는 `<artifact-path>`, optional `--limit=N` | `~/.deep-memory/events/YYYY-MM.jsonl` (idempotent key), `~/.deep-memory/cards/<type>/{global,project_id}/*.json` (D15), `.deep-memory/latest-harvest.json` |
| `deep-memory-brief` | true | task 텍스트(positional string, max 2000 chars, UTF-8, 빈 입력 = error) 에 대한 top-N memory brief. retrieval lock 대기 + 정규화 score (F7) | `"<task description>"` (single positional, ≤2000 chars) | `.deep-memory/latest-brief.json`, `.deep-memory/latest-brief.md` |
| `deep-memory-audit` | true | schema validation + 3-pass redaction sample + stale memory + stale lock detect + dedupe collision + source-rename detect + profile freshness | 없음, optional `--unlock` (D18 stale lock break), `--promote <memory-id>` (D15 local → global 명시 승격) | `.deep-memory/latest-audit.json` (콘솔 표시) |
| `memory-schema` | **false** | M3 envelope, card schema (normative — `schemas/memory-card.schema.json` 참조), state machine, dedupe 규칙, 3-pass redaction, atomic write 규칙의 단일 진실 — 다른 4개 skill이 inline reference | — | — |

**제약**:
- 모든 user-invocable skill의 frontmatter `description` ≤ 1024자 (Codex strict 한계, 제안서 §16에서 deep-evolve가 이미 겪었던 함정).
- Codex strict YAML — description에 `colon-space` 패턴 (예: `Use: when ...`) 금지 또는 인용. deep-wiki v1.6.1 사례.

---

## 6. Memory Card Schema

> **Normative**: 본 섹션의 모든 필드/enum/제약은 `schemas/memory-card.schema.json` 에서 JSON Schema (draft 2020-12) 로 정의되고 Ajv 로 strict validation. `additionalProperties: false`. example 만이 아니라 schema 가 진실의 출처 (R1 F5).

### 6.1 Full payload

```json
{
  "$schema": "https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json",
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-memory",
    "producer_version": "0.1.0",
    "artifact_kind": "memory-card",
    "run_id": "01H...",
    "generated_at": "2026-05-20T00:00:00Z",
    "schema": { "name": "memory-card", "version": "1.0" },
    "git": { "head": "0000000", "branch": "global-memory", "dirty": "unknown" },
    "provenance": {
      "source_artifacts": [
        {
          "path": ".deep-review/recurring-findings.json",
          "content_hash": "sha256:de4b...",       // F8 — rename/delete 후 provenance 유지
          "captured_at": "2026-05-20T00:00:00Z",  // F8
          "artifact_kind": "recurring-findings",   // F16 — schema-version guard
          "schema_version": "1.0",                 // F16
          "run_id": "01H..."
        }
      ],
      "tool_versions": { "node": "22.x" }
    }
  },
  "payload": {
    "memory_id": "mem_failure_8f42a1",
    "memory_type": "failure-case",                 // enum: pattern | failure-case | architecture-decision | experiment-outcome | coding-style
    "dedupe_key": "sha256:abc123...",
    "privacy_level": "local",                       // D15 — enum: local | global. default local
    "title": "Codex skill discovery can silently fail on invalid skill metadata",
    "claim": "When migrating slash commands to Codex skills, strict metadata constraints can cause skills to be silently dropped unless manifest and skill frontmatter are validated.",
    "evidence_summary": [                           // F17 — max 5 items, each ≤200 chars
      "deep-evolve trimmed skill description below Codex limit",
      "deep-wiki fixed frontmatter YAML parsing issue"
    ],
    "applicability": [                              // F21 — per-source provenance
      {
        "value": "command-to-skill migration",
        "source_id": "src_0",                       // index into provenance.source_artifacts
        "confidence": 0.9
      },
      {
        "value": "Codex plugin compatibility",
        "source_id": "src_0",
        "confidence": 0.85
      }
    ],
    "non_applicability": [
      {
        "value": "Claude Code slash-command-only plugin",
        "source_id": "src_0",
        "confidence": 0.8
      }
    ],
    "recommended_action": [
      "Add manifest drift tests",
      "Run skill-reviewer against every user-invocable skill",
      "Validate YAML frontmatter strictly"
    ],
    "search_keywords": [                            // F25 — Step B 가 emit, FTS5 index 에 포함
      "codex", "skill discovery", "frontmatter", "manifest validation",
      "skill dropping", "yaml parsing"
    ],
    "confidence": 0.86,
    "status": "validated",                          // enum: candidate | validated | contradicted | deprecated
    "status_history": [                             // F20 — 카드 내부엔 마지막 10개만, 전체는 transitions-YYYY-MM.jsonl
      { "from": "candidate", "to": "validated", "at": "2026-05-20T00:00:00Z", "by": "auto:evidence_threshold>=2" }
    ],
    "tags": ["codex", "skills", "manifest", "plugin-migration"],
    "created_at": "2026-05-20T00:00:00Z",
    "last_seen_at": "2026-05-20T00:00:00Z",
    "review_after": "2026-08-20T00:00:00Z",
    "feedback": {
      "accepted_count": 0,
      "rejected_count": 0,
      "inaccurate_count": 0
    },
    "redaction_metadata": {                         // F18 — false-positive 감지
      "rules_matched": 2,
      "chars_masked": 47,
      "preview": "...api_key=[REDACTED]..."
    }
  }
}
```

### 6.1.a 필드 제약 (normative summary, full은 schema)

| 필드 | 타입 | 제약 |
|---|---|---|
| `memory_type` | enum | `pattern \| failure-case \| architecture-decision \| experiment-outcome \| coding-style` |
| `privacy_level` | enum | `local \| global`, default `local` (D15) |
| `claim` | string | non-empty, max 600 chars |
| `evidence_summary` | array<string> | max 5 items, each ≤200 chars (F17) |
| `applicability[].confidence` | number | 0.0~1.0 |
| `search_keywords` | array<string> | max 15 items, each ≤40 chars (F25) |
| `confidence` | number | 0.0~1.0 |
| `status` | enum | `candidate \| validated \| contradicted \| deprecated` |
| `status_history` | array<object> | max 10 entries (overflow → transitions JSONL, F20) |
| `redaction_metadata` | object | F18 |

### 6.2 `dedupe_key` 산출

R1 F15 / agy #3 / Codex rev §6.2-lossy 반영 — stop-word 제거가 "use A for B" vs "use A to B" 같은 의미 다른 claim 을 잘못 병합. 보수화:

```text
dedupe_key = "sha256:" + sha256(
  memory_type + "|" + normalize(claim) + "|" + applicability_seed_hash
)
normalize(text):
  - lowercase
  - collapse whitespace to single space
  - keep alphanumeric + space ONLY (모든 punctuation 제거, stop-word 제거 안 함)
  - trim
applicability_seed_hash:
  - sorted(applicability[].value) → join("|") → sha256 → first 8 hex chars
  - (applicability 배열이 비면 빈 문자열)
```

이렇게 하면:
- "use A for B" vs "use A to B" → normalize 후 다른 텍스트, 다른 hash (보존)
- 같은 claim 이지만 applicability 다르면 다른 dedupe_key → 별개 카드 (예: same claim 이 typescript/python 두 stack 에서 발생)
- 모든 fallback 경로의 carded claim 가 적어도 `title` 에서 derive 되므로 (§7.1 F1 fix), empty-claim 충돌 발생 안 함

충돌 시 동작 (F14 — 단순 union 의 over-broadening 방지):
1. 기존 card 의 `last_seen_at` 갱신.
2. 신규 `evidence_summary` 항목을 기존과 union, 중복 제거, max 5 enforce (overflow 면 confidence 높은 evidence 우선).
3. `confidence` 재계산: `min(1.0, existing_confidence + 0.05 × new_evidence_count)`.
4. `applicability` / `non_applicability` 는 union 하되 per-item `source_id` 보존 (F21) — 두 source 가 contradicting applicability 를 주장하면 audit 가 `applicability_contradiction` 리포트.
5. `tags` 는 단순 union (제한 없음).
6. `recommended_action` 은 기존 유지 (덮어쓰지 않음).
7. `search_keywords` 는 union, max 15 enforce.
8. **cross-type 충돌 회피 invariant**: `memory_type` 이 다르면 항상 별개 카드 (dedupe_key 에 type 포함되어 자동 보장). `tests/dedupe.test.js` 에 명시 회귀 케이스 (F22).

semantic dedupe (의미는 같지만 표현이 다름) 은 Phase 4+ 로 이연 — embedding 도입 시점.

### 6.3 Status state machine

R1 F (review): MVP 는 feedback hook 미구현이므로 "reused 90d" 조건은 측정 불가능 → time-only 룰로 단순화.

```text
                ┌─────────┐
                │candidate│
                └────┬────┘
       evidence>=2  │   contradicting>=1
       no contra    │
                    ▼          ▼
                ┌──────────┐ ┌─────────────┐
                │validated │ │contradicted │
                └────┬─────┘ └──────┬──────┘
  age(review_after) │              │ new_supporting>=2
   > stale_grace    │              │
   _days            ▼              ▼
                ┌──────────┐  (back to candidate)
                │deprecated│
                └──────────┘

manual: /deep-memory-audit --promote <id>  (D15 — local → global 명시 승격)
        /deep-memory-audit --demote <id>   (Phase 4+, deferred)
```

자동 전이는 `deep-memory-audit` 실행 시에만 평가 (실시간 X). 모든 전이는 `status_history` 에 `{from, to, at, by}` 로 append. **카드 내부 retention = 마지막 10 entries 만** (F20 — 그 이상은 `~/.deep-memory/events/transitions-YYYY-MM.jsonl` 으로 spill).

`--promote` 의 효과는 `privacy_level: local → global` 전이 + `cards/<type>/<project_id>/` → `cards/<type>/global/` 로 atomic move. 자동 promote 없음 — 사용자 명시 호출만 (D15, R1 F9).

### 6.4 Conflict resolution policy

두 card가 같은 `dedupe_key` 지만 `claim` / `applicability` 가 의미상 다를 때 (rule-based normalize는 같게 만들지만 사용자가 보기엔 다른 경우):

- **last_seen_at 신순** + **evidence_summary union** + **status는 더 보수적인 쪽** (`candidate > validated > contradicted > deprecated`) → 추후 사람 판단 보류.
- audit 단계에서 `dedupe_collision` 리포트로 노출.

---

## 7. Distill pipeline (Hybrid)

### 7.1 Step A — Rule-based extraction (deterministic)

R1 F1 응답 — 모든 memory_type 이 deterministic `claim` source 를 가져야 함 (fallback path 가 발동해도 빈 claim 으로 persist 되지 않도록).

| Source artifact | Memory type | 매핑 규칙 (claim source는 굵게) |
|---|---|---|
| `.deep-review/recurring-findings.json` | `failure-case` | `finding.title → title`, **`finding.title → claim`**, `finding.evidence → evidence_summary[]`, `finding.tags → tags`, `finding.first_seen → created_at`, `finding.category → applicability seed` |
| `.deep-evolve/*/evolve-insights.json` | `experiment-outcome` | `insight.strategy → title`, **`insight.strategy → claim`**, `insight.q_delta` (0~1 normalize) `→ confidence`, `insight.project_signature → applicability seed`, `insight.outcome → evidence_summary[0]` |
| `.deep-work/*/session-receipt.json` (성공 slice) | `pattern` | `slice.title → title`, **`"Pattern: " + slice.title + " — " + slice.outcome_summary → claim`**, `slice.id → evidence_summary[0]` |
| `.deep-work/*/session-receipt.json` (실패 slice) | `failure-case` | `slice.title → title`, **`"Failure: " + slice.title + " — " + slice.failure_reason → claim`**, `slice.id → evidence_summary[0]` |
| `.deep-docs/last-scan.json` | `coding-style` | `drift.title → title`, **`drift.title + " — " + drift.recommended_fix → claim`**, `drift.path → evidence_summary[0]` |
| `<wiki_root>/.wiki-meta/index.json` | `architecture-decision` | `page.frontmatter.adr=true` 인 페이지만. `page.title → title`, **`page.frontmatter.decision_summary || page.title → claim`**, `page.path → evidence_summary[0]` |

**Invariant** (R1 F1, F5):
- 매핑 후 `claim` 이 empty 면 Step A 에서 **draft 자체를 quarantine** (`~/.deep-memory/.quarantine/empty-claim/<run_id>.json`) + audit 리포트. 절대 persist 하지 않음.
- 같은 invariant 가 `title` / `evidence_summary` 중 하나가 비면도 적용.

Step A 산출: `event-draft.json` (envelope-wrapped, in-memory). lock 안에서 §7.3 의 idempotent persist 단계로 즉시 전달 (race 차단 — F4).

### 7.2 Step B — LLM sub-agent refinement (graceful, cross-runtime)

R1 F6 (pre-LLM redaction) + F5 (output schema validation) + F11 (cross-runtime bridge) + F25 (search_keywords) 반영.

- **Adapter bridge** (D19 / R1 F11): `scripts/lib/llm-bridge.js` 가 다음 adapter 중 1개 선택:
  - `claude-agent` — Claude Code 환경에서 `Agent({subagent_type: "memory-distiller"})`
  - `codex-bash` — Codex 환경에서 `codex review` bash CLI 호출 (envelope JSON으로 stdin)
  - `gemini-sdk` — Gemini CLI/SDK 환경 (별도 wrapper)
  - `stdin-fallback` — 어떤 host LLM도 감지 안 되면 사용자에게 prompt 출력 + 응답을 stdin 으로 받음 (CI/오프라인 환경)
  - `auto` (기본) — adapter-registry.js 가 환경 감지로 위 중 1개 선택
- **Sub-agent definition**: `agents/memory-distiller.md` (Read-only, Write/Edit 없음). 모든 adapter 가 같은 prompt template + I/O schema 를 공유.
- **Input** (redact 후, R1 F6 — 3-pass redaction 의 2번째 pass):
  - event-draft (Step A 산출, redact 적용 후)
  - source artifact 발췌 (최대 4096 bytes, redact 적용 후)
  - `evidence_paths` 의 home/customer path segment 는 hash 처리 (e.g., `/Users/<u_a1b2>/work/...`)
- **Task**: 빈 칸만 채움 — `claim` 정제 (Step A 가 채운 baseline을 더 풍부하게), `non_applicability` 추론, `recommended_action` 합성, `search_keywords` 생성 (F25).
- **Output schema validation** (R1 F5):
  - sub-agent 응답 JSON 을 `schemas/memory-card-distill-output.schema.json` 으로 Ajv strict validation.
  - 위반 (할루시네이션 필드, 잘못된 enum, max-length 초과, 누락 필드) = candidate fallback.
- **Invariant**: Step A가 채운 필드는 sub-agent가 절대 덮어쓰지 않음 — `lib/llm-bridge.js` 가 응답 merge 시 Step A 필드를 모드 우선 (test 로 검증).
- **Timeout**: `config.yaml` 의 `distill.llm.timeout_ms` (기본 30000ms).
- **Fallback** (host LLM 미가용 / timeout / parse error / schema violation):
  - card 저장하되 `status: candidate`, `confidence: 0.4`, LLM-derived 필드 (`non_applicability`, `search_keywords` 등) 는 빈 배열.
  - `recommended_action` 도 빈 배열.
  - **`claim` 은 절대 비지 않음** (§7.1 Step A 가 항상 채우므로 — R1 F1 fix). dedupe_key 충돌 안 함.
  - `audit` 단계의 `incomplete_cards` 리포트에 노출.

### 7.3 Step C — Persist (lock + lease + atomic + idempotent)

R1 F3 (atomic write) + F4 (concurrent harvest idempotency) + 부분 실패 보장 강화.

1. **Project lease 획득** (F4 — 같은 project_id 에 대한 두 세션 동시 harvest 차단):
   - `~/.deep-memory/.leases/<project_id>.lease` 에 `{pid, host, started_at}` atomic write.
   - 기존 lease 가 있으면 → `started_at` 이 30분 이내면 abort + "다른 세션이 harvest 중" 안내. 30분 초과면 stale 로 간주하고 break.
2. **Global lock 획득** (D18 — write 직렬화):
   - `mkdir ~/.deep-memory/.lock/` (atomic). 성공 시 그 안에 `{pid, host, created_at, operation: "harvest"}` JSON 저장.
   - 다른 프로세스가 lock 보유 중이면 50ms backoff × 최대 60회 (3초). 그래도 못 잡으면 abort.
3. **Event idempotent append** (F4):
   - event key = `sha256(source_artifact.path + source_artifact.content_hash + run_id)`.
   - 기존 `events/YYYY-MM.jsonl` 에서 같은 key 가 이미 있으면 skip (no-op).
4. **dedupe_key 충돌 검사 → 신규/병합 결정** (§6.2).
5. **card 파일 atomic write** (D18 / F3):
   - `<target>.tmp` 작성 → `fsync(file)` → `fsync(dir)` → atomic rename → readback validate (JSON parse + schema validate).
   - readback 실패 시 `<target>.tmp.corrupt-<ts>` 로 격리 + audit 리포트.
6. **events JSONL atomic append**:
   - 같은 atomic write 정책. append 가 아니라 (read all → append new entry → atomic write) 사이클 — JSONL 파일 자체는 작으므로 비용 acceptable.
7. **FTS5 index 갱신**:
   - **단일 sqlite transaction** 안에서 (claim + applicability + tags + search_keywords) 인덱싱.
   - **transaction commit** 직후 release (R1 F11 — brief 즉시 호출 시 stale 방지).
8. lock + lease 해제 (lock 디렉토리 삭제, lease 파일 삭제).

**Stale lock recovery** (D18 / R1 F3 / agy #6):
- 모든 lock 획득 시도 시 `created_at` 검사 — 5분 초과면 stale 로 간주, `--unlock` 안내 + audit 리포트.
- `deep-memory-audit --unlock` 명령 (lock 디렉토리 강제 삭제, lease 도 같이 정리).

**Partial-failure 보장**:
- 5번 card write 후 6/7번 실패 → card 는 유지 (다음 audit 가 `index_orphan` 감지 → `deep-memory-audit --rebuild-index` 안내).
- 5번 자체 실패 → readback validate 가 차단. quarantine 으로 격리.
- MVP 는 transactional 보장 X (3+개 storage 동시 atomic 은 SQLite 만으로 어려움). audit + rebuild 안내로 풀어감.

### 7.3.a brief 의 read-side 보장 (R1 F11)

`deep-memory-brief` 도 `~/.deep-memory/.lock/` 을 acquire 시도 (operation: "brief"). lock 점유 중이면 50ms backoff × 60회. 끝까지 못 잡으면 "harvest 진행 중 — 잠시 후 다시 시도" 안내 + exit code 2.

SQLite FTS5 read 는 동일 lock 안에서 수행 (transaction commit 후 release 되었으므로 stale 위험 없음).

### 7.4 Eval harness (검토 H1 응답)

- `tests/distill-golden.test.js`:
  - Input fixture: `tests/fixtures/sample-recurring-findings.json` 등
  - Expected output: `tests/fixtures/golden-cards/expected_failure_*.json`
  - 매칭 정책:
    - rule-based 필드 (memory_type, evidence_summary, source_artifacts) 는 **정확 일치**
    - LLM-derived 필드 (claim, non_applicability) 는 **키워드 포함 검증** (e.g., claim text가 정의된 핵심 키워드 N개 중 M개 이상 포함)
  - Step B는 mock LLM 으로 대체 (test에서는 결정적 응답 주입)
  - regression 차단: golden fixture 갱신은 PR 리뷰 필수

---

## 8. Retrieval pipeline (MVP: lexical only)

제안서 §13의 6단계 중 MVP 적용:

| 단계 | MVP | 구현 |
|---|---|---|
| 1. Hard filter | ✅ | `status != deprecated` + privacy scope + `review_after` age check |
| 2. Project similarity | ✅ | project-profile.json 비교 (languages, runtimes, topology) — Jaccard similarity score (0~1) |
| 3. Task similarity | ✅ | sqlite FTS5 BM25 on `claim` + `tags` + `applicability` |
| 4. Evidence quality | ✅ | `confidence × log(1 + evidence_count) × (1 − rejected/(accepted+rejected+1))` |
| 5. Applicability guard | ✅ | task text가 `non_applicability` 의 어떤 항목과도 fuzzy match (Jaccard 토큰 ≥ 0.5) 시 제외 |
| 6. Diversity | ✅ | memory_type별 top-N (`diversity_per_type`, 기본 2개) + 같은 `dedupe_key` 부근 클러스터 1개만 |

MVP에서 **제외**: semantic embedding (Phase 4+ — `indexes/semantic.sqlite` 자리만 비워둠).

최종 score (R1 F7 — 모든 항 0-1 정규화):

```
score = w1 · project_sim_norm + w2 · task_sim_norm + w3 · evidence_quality_norm
        − w4 · stale_penalty_norm
w1=0.2, w2=0.5, w3=0.3, w4=0.1 (config.yaml 에서 override)
```

정규화 규칙 (`scripts/lib/score.js`):
- `project_sim_norm` = Jaccard ∈ [0,1] (자연 0-1).
- `task_sim_norm` = BM25 raw score 에 대해 retrieval 결과 batch 안에서 **min-max scaling** ([min, max] → [0, 1]). 결과 1개면 1.0.
- `evidence_quality_norm` = `sigmoid(confidence × log(1 + evidence_count) × (1 − rejected/(accepted+rejected+1)))`. sigmoid 로 [0,1] clamp.
- `stale_penalty_norm` = `clamp((now − review_after) / (stale_grace_days × 86400), 0, 1)` (review_after 가 미래면 0).

`top_n` (기본 8) 만 반환.

**Degraded path 거동**:
- 0개 memory → brief 는 빈 `memories: []` 반환 (error 아님), markdown 에 "no relevant memories" 안내.
- 모든 candidates 가 stale → 정상 ranking + brief 에 stale warning 헤더.
- `project-profile.json` 없거나 stale → `project_sim` 항 가중치를 0 으로 강제 (config.yaml 의 `w_project_sim` override) + brief 에 "profile not initialized" 경고.

---

## 9. Brief output

두 파일 동시 생성 (deep-work Research가 둘 다 활용 가능):

### 9.1 `.deep-memory/latest-brief.json` (machine-readable)

```json
{
  "envelope": { /* M3 */ },
  "payload": {
    "task": "implement Codex-compatible plugin manifest",
    "retrieved_at": "2026-05-20T00:00:00Z",
    "top_n": 8,
    "memories": [
      {
        "memory_id": "mem_failure_8f42a1",
        "memory_type": "failure-case",
        "claim": "...",
        "why_relevant": "tags overlap (codex,plugin) + project signature match (typescript+plugin-marketplace)",
        "evidence_paths": [".deep-review/recurring-findings.json"],
        "recommended_action": ["..."],
        "avoid_when": ["Claude Code slash-command-only plugin"],
        "score": 0.87
      }
    ]
  }
}
```

### 9.2 `.deep-memory/latest-brief.md` (human/LLM-readable)

```md
## Cross-project Memory Brief

> Task: implement Codex-compatible plugin manifest
> Retrieved: 2026-05-20T00:00:00Z (top 8 of 142 candidates)

### Related failure cases (3)

- **Codex skill discovery can fail on invalid frontmatter.**
  - Applicability: command-to-skill migration
  - Recommended action: run strict YAML validation + skill-reviewer
  - Avoid when: Claude Code slash-command-only plugin
  - Source: `.deep-review/recurring-findings.json`

...

### Related architecture decisions (2)
...

### Related coding-style rules (1)
...
```

**Field mapping 명세 (R1 F2 — `avoid_when` ↔ `non_applicability` 모호 해소)**:

| Brief field | 출처 |
|---|---|
| `claim` | `card.payload.claim` (Step A 가 항상 채움, 빈 값 발생 불가 — F1 fix) |
| `why_relevant` | retrieval pipeline 산출 (project_sim + task_sim + applicability match 설명, max 200 chars) |
| `evidence_paths` | `card.envelope.provenance.source_artifacts[].path` (privacy-redacted) |
| `recommended_action` | `card.payload.recommended_action` |
| `avoid_when` | `card.payload.non_applicability[].value` (per-source provenance 의 `value` 만 추출) |
| `score` | §8 score |

**Per-card fallback (R1 F2 — brief 전체 fail 차단)**:
- `why_relevant` 가 비면 (이론상 불가능, 안전망) → `"(retrieved by lexical match)"` 로 default.
- `avoid_when` 이 비면 (pattern / coding-style 자연 케이스) → `"(none specified)"` 로 default render.
- `recommended_action` 이 비면 (Step B fallback 케이스) → `"(none — refer to evidence)"` 로 default render.
- 즉 **개별 카드의 빈 필드는 brief 생성 fail 의 사유가 아님**. brief 는 항상 성공 (degraded 모드라도).
- 단, brief 출력 schema validation 은 강제 — JSON 모양 자체가 안 맞으면 그 카드를 skip + warning.

---

## 10. Cross-plugin contracts (MVP는 최소)

### 10.1 deep-memory는 read-only consumer

다른 플러그인 코드/SKILL/hook을 변경하지 않음. harvest는 이미 emit된 artifact를 읽기만 함. brief는 deep-work이 활용 여부를 결정 (별도 PR).

### 10.2 `~/.deep-memory/config.yaml`

```yaml
version: "0.1.0"
memory_root: ~/.deep-memory
privacy:
  default_scope: local
  allow_export: false
sources:
  # F16 — schema_version guard 도입: 미지원 version 명시 fail (silent mis-map 방지)
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
    memory_type: pattern  # 또는 failure-case (slice outcome 기반 분기)
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
suppressions_file: ~/.deep-memory/suppressions.yaml
```

### 10.3 `deep-suite/.claude-plugin/suite-extensions.json` 에 추가할 entry

```json
"deep-memory": {
  "runtime": ["node", "bash"],
  "capabilities": [
    "cross-project-memory",
    "lexical-retrieval",
    "failure-reuse",
    "experiment-outcome-memory",
    "memory-audit",
    "redaction-guard"
  ],
  "artifacts": {
    "writes": [
      ".deep-memory/project-profile.json",
      ".deep-memory/latest-harvest.json",
      ".deep-memory/latest-brief.json",
      ".deep-memory/latest-brief.md",
      ".deep-memory/latest-audit.json",
      "~/.deep-memory/events/*.jsonl",
      "~/.deep-memory/cards/**/*.json",
      "~/.deep-memory/indexes/lexical.sqlite"
    ],
    "reads": [
      ".deep-work/**",
      ".deep-review/**",
      ".deep-evolve/**",
      ".deep-docs/**",
      ".deep-dashboard/**",
      "<wiki_root>/.wiki-meta/**"
    ]
  },
  "hooks_active": [],
  "hooks_intentionally_empty_reason": "Cross-project memory의 privacy와 trust boundary를 보장하기 위해 MVP는 user-invocation 기반만 지원한다. 자동 hook은 Phase 4+ opt-in으로만 도입."
}
```

### 10.4 `data_flow` 추가 edges (MVP 4개)

```json
{ "from": "deep-review",  "to": "deep-memory", "via": "recurring-findings.json (harvest read-only)" },
{ "from": "deep-evolve",  "to": "deep-memory", "via": "evolve-insights.json (harvest read-only)" },
{ "from": "deep-work",    "to": "deep-memory", "via": "session-receipt.json (harvest read-only)" },
{ "from": "deep-memory",  "to": "deep-work",   "via": "latest-brief.json/md (Research opt-in read)" }
```

### 10.5 Marketplace 양쪽 entry

`deep-suite/.claude-plugin/marketplace.json` + `deep-suite/.agents/plugins/marketplace.json` 둘 다 `deep-memory` entry 추가. `source.url + sha` 는 GitHub repo 생성 후 정정.

---

## 11. Privacy / Redaction (MVP)

### 11.1 Rule-based 3-pass (MVP — D17 / R1 F6)

`scripts/lib/redact.js` 가 다음 **3개 위치**에서 redaction 수행:

1. **Pass 1 — Step A input**: source artifact 발췌가 event-draft 에 들어가기 전. 이 단계에서 잡힌 secret 은 evidence_summary, recommended_action 시드에 leak 안 됨.
2. **Pass 2 — Step B input** (R1 F6 — 가장 큰 leak risk): sub-agent 에 보내는 prompt body 에 대해 다시 redact. host LLM (Claude / Codex / Gemini) 에게 raw secret 이 가지 않도록 보장.
3. **Pass 3 — envelope wrap 직전**: 최종 envelope-wrapped artifact (event JSONL, card JSON) 에 다시 redact. Step B 응답이 새 secret 을 introduce 했을 경우 (드물지만 가능) 차단.

`evidence_paths` 처리:
- home/customer path segment 는 hash 처리: `/Users/<u_a1b2>/work/<p_c3d4>/...`
- 원본 path 는 별도 audit log 에만 (사용자 본인만 접근 가능) — `~/.deep-memory/.audit/path-resolutions.jsonl`

### 11.1.a 패턴 (모든 pass 에서 동일 적용)

- API keys / tokens — `(?i)(api[_-]?key|token|secret|bearer)[\s:=]+["']?[A-Za-z0-9_\-]{16,}`
- 이메일 — `[\w.+-]+@[\w-]+\.[\w.-]+`
- DB connection strings — `(postgres|mysql|mongodb|redis|amqp)://[^\s]+`
- Home path — `/Users/<user>/`, `/home/<user>/` → `~/`
- 사설 IP — `10\.\d+\.\d+\.\d+`, `192\.168\.\d+\.\d+`, `172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+`
- 내부 도메인 — `.internal`, `.local`, `.lan`
- `evidence_paths` 는 유지 (path만), `evidence_content` 필드는 schema에 존재하지 않음 (저장 금지)

### 11.2 `suppressions.yaml` (사용자 추가 패턴)

```yaml
deny_patterns:
  - "acme-internal"
  - "/projects/customer-.*"
deny_projects:
  - proj_id: "proj_xxx"
    reason: "client work, no cross-project export"
allow_patterns:                 # F18 — false-positive 보정 (deny 패턴이 mask 한 것을 다시 unmask)
  - "SQL_INJECTION"             # 예: 패턴 분류 키워드가 token 매칭에 잘못 걸린 경우
```

### 11.2.a Redaction metadata (R1 F18)

모든 card 에 `redaction_metadata` 필드 자동 채움 (§6.1 참조):

```json
{
  "rules_matched": 2,
  "chars_masked": 47,
  "preview": "...api_key=[REDACTED]..."
}
```

`deep-memory-audit` 출력에 다음을 노출:
- `high_redaction_cards`: `chars_masked > 200` 인 카드 목록 — false-positive 의심.
- `zero_redaction_high_risk_paths`: source artifact 에 secret 패턴 외 free-form 텍스트가 많은데 redaction 0 인 경우 — false-negative 의심.

### 11.3 CI invariant test

`tests/redaction.test.js` — known-secret fixture (`tests/fixtures/dangerous-secrets.json`) 을 harvest 입력으로 던져서, 산출 event / card / brief 그 어디에도 매치되지 않음을 검증. CI 게이트.

### 11.4 LLM second-pass (Phase 4+)

MVP는 rule-based 1-pass만. false-negative는 audit 시 콘솔에 경고 (LLM second-pass는 handoff doc 참조).

---

## 12. Testing strategy

R1 F12 (runtime-contract) + F22 (cross-type dedupe) + F23 (test scope 확장) 반영.

| Test | 목적 | 파일 |
|---|---|---|
| envelope-emit | 모든 산출 artifact가 M3 envelope-wrapped + `producer:deep-memory` + schema 유효 | `tests/envelope-emit.test.js` |
| harvest-golden | rule-based extraction 결정성 — 같은 fixture → 같은 event | `tests/harvest-golden.test.js` |
| distill-golden | Hybrid distill 회귀 차단 (LLM Step B mock) + Step A invariant (Step A 필드 절대 덮어쓰기 X) | `tests/distill-golden.test.js` |
| redaction | 3-pass invariant (Step A in / Step B in / wrap 직전 모두 mask) + known-secret fixture + suppressions 적용 | `tests/redaction.test.js` |
| dedupe | 같은 claim 두 번 → card 1개 + union + **cross-type 케이스** (같은 normalized claim, 다른 memory_type → 별개 카드) + applicability_seed 차이로 분리 (F22) | `tests/dedupe.test.js` |
| state-machine | 4 자동 + 1 수동 전이 + status_history 10-entry 캡 + transitions JSONL spill | `tests/state-machine.test.js` |
| manifest-drift | `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `package.json` version 3중 동기 + **strict YAML frontmatter parsing test** + **Codex 1024-char description check** + **suite-extensions schema validation** (F23) | `tests/manifest-drift.test.js` |
| atomic-write | tmp+fsync+rename 시나리오, crash-mid-write 시뮬레이션, readback validate (F3) | `tests/atomic-write.test.js` |
| lock | stale lock (>5min) detect + `--unlock` recover + concurrent acquire backoff (F3) | `tests/lock.test.js` |
| score-normalization | 모든 항 0-1 clamp + zero-memory / all-stale / missing-profile degraded path (F7) | `tests/score-normalization.test.js` |
| concurrent-harvest | 두 세션 동시 harvest → event 중복 0 + lease 가 1개만 진행 + 두 번째 abort (F4) | `tests/concurrent-harvest.test.js` |
| source-hash | source artifact rename/delete → provenance content_hash 로 식별 가능 + audit unresolved-source 리포트 (F8) | `tests/source-hash.test.js` |
| runtime-contract/* | adapter 별 smoke fixture (claude-agent / codex-bash / stdin-fallback) + recorded golden response hash 비교 (F12) | `tests/runtime-contract/*.test.js` |

`npm test` 단일 명령으로 전체 실행. Node 22 LTS, `node --test` runner.

**CI gate**:
- 모든 test PASS 필수.
- `tests/redaction.test.js` 의 known-secret fixture 는 **실제 secret 형식 (entropy ≥ 4)** 을 포함 — 산출 어디에도 매치되지 않음을 검증 (실제 git push 전 git-hook 도 동일 검증).

---

## 13. CLAUDE.md / AGENTS.md 가이드

사용자 명시 "짧게" 우선. 형제 분량 (deep-wiki CLAUDE.md = 14KB) 의도적으로 따르지 않음.

### 13.1 CLAUDE.md outline (~2KB)

```text
# deep-memory — Project Guide for Claude

## Project Overview              (3-4 lines)
## Three-layer model             (events → cards → brief)
## Cross-runtime surfaces        (Claude Code / Codex / Copilot / Gemini)
## Directory Structure           (압축 tree, 15 lines)
## MVP Commands                  (4 entry skills, 한 줄씩)
## Storage layout                (memory_root + project-local)
## Cross-repo Update Workflow    (deep-suite marketplace sync, 5 lines)
## Privacy invariant             (1 line)
## Pointers                      (CHANGELOG, spec doc)
```

### 13.2 AGENTS.md outline (~1KB, 형제 deep-wiki 패턴 그대로)

```text
# deep-memory - Codex Project Guide
(1-3 line description)
Current version: 0.1.0.

## Runtime Surfaces (bullet list)
## Verification (3-line bash block)
(closing sentence about updating suite marketplaces)
```

---

## 14. Handoff documents

### 14.1 `docs/handoff-phase-4-6.md` (deep-memory 자체 후속)

내용:
1. **현재 v0.1.0 범위 요약** (Phase 0~3 done)
2. **Phase 4 — deep-review/deep-evolve writer integration**
   - deep-review가 review 시작 시 brief 호출 / 종료 시 새 failure-case 후보 emit
   - deep-evolve init이 experiment-outcome memory를 strategy seed로 활용
   - 양쪽 모두 별도 PR (deep-memory 자체는 그대로)
3. **Phase 5 — Reasoning Graph**
   - `graph/nodes.jsonl` + `edges.jsonl`
   - sqlite recursive CTE 기반 lineage query
   - `/deep-memory graph` 명령 신설
   - `/deep-memory rebuild` (인덱스 일관성 복구) 명령 신설
4. **Phase 6 — Dashboard Telemetry**
   - 8개 metric (제안서 §8.6 그대로) 을 deep-dashboard 집계기에 추가
   - memory debt 알림
5. **Phase 진입 전 closing 체크리스트**
   - dedupe collision rate 측정 → semantic dedupe 필요성 판단
   - feedback signal volume 측정 → Phase 6 metric 의미성 판단
   - rule-based redaction false-negative rate → LLM second-pass 도입 판단
6. **명시적 out-of-scope (계속)**
   - team/org privacy scope
   - 자동 SessionStart/Stop hook
   - vector DB / embedding

### 14.2 `/Users/sungmin/Dev/claude-plugins/deep-work/docs/deep-memory-integration-handoff.md`

deep-work 측이 deep-memory의 brief를 활용하기 위한 후속 작업 명세:

1. **현재 deep-work 상태** (deep-memory와 분리 운영, brief를 알지 못함)
2. **추가할 작업 (deep-work CLAUDE.md / Research phase skill 수정)**
   - Phase 1 Research 시작 시 `.deep-memory/latest-brief.md` 존재 여부 확인
   - 존재하면 Research artifact의 "Cross-project Memory" 섹션에 인용
   - 부재 시 `/deep-memory-brief "<task>"` 호출을 사용자에게 제안 (auto-invoke X — privacy)
3. **Phase 5 Integrate top-3 후보에 `/deep-memory-harvest .deep-work/<session>` 추가**
4. **Research artifact schema 확장** (Cross-project Memory 섹션을 schema에 명시)
5. **Feedback hook** (검토 H4)
   - Research 단계 후 사용자가 "이 memory 사용했다 / 안 했다" 표시 → `/deep-memory feedback <memory-id> <accepted|rejected>` (MVP에선 deep-memory 측 명령 미구현; Phase 4+에서 양쪽 동시 도입)
6. **Test 추가** — deep-work이 brief 없이도 정상 동작 (graceful) + brief 있으면 인용 (test fixture로 검증)

---

## 15. Implementation phases

R1 F14 (Phase 3 분리) + F13 (Phase 0 install probe) + F11/F12/F24 (Phase 3 에 adapter + runtime-contract) 반영.

| Phase | 산출 | 추정 |
|---|---|---|
| 0. Skeleton | `git init` (완료), `.gitignore`, plugin.json × 2, CLAUDE.md, AGENTS.md, README × 2, LICENSE, package.json, **better-sqlite3 install probe** (F13 — `node -e "require('better-sqlite3')"` PASS 확인, fail 시 `sql.js` fallback 자동 적용), 첫 commit | 0.5일 |
| 1. Schemas + scripts/lib | `envelope.js`, `redact.js` (3-pass), `dedupe.js` (보수화), `state-machine.js`, **`lock.js` (Node, Windows portable, F24)**, `atomic-write.js`, `source-hash.js`, `score.js`, `preflight.js`, `adapter-registry.js`, `schemas/memory-card.schema.json` (normative, F5) + `schemas/memory-event.schema.json` + `schemas/project-profile.schema.json` + `schemas/memory-card-distill-output.schema.json` | 1.5일 |
| 2. Harvest | `deep-memory-init` + `deep-memory-harvest` skills, `harvest.js` (Step C atomic + lease + idempotent), preflight 통과, 3-pass redaction Pass 1 동작, project-profile global+local 동기화 | 1.5일 |
| **3a. Distill — rule (Step A)** | Step A 매핑 (5 memory_type 모두 claim 결정적 source), quarantine 정책, harvest 통합 | 1.5일 |
| **3b. Distill — sub-agent + bridge (Step B)** | `agents/memory-distiller.md`, `scripts/lib/llm-bridge.js` (claude-agent / codex-bash / stdin-fallback 3 adapter MVP), Step B output schema validation, golden eval harness (mock LLM), runtime-contract recorded fixtures (F12) | 2.5일 |
| 4. Brief | `deep-memory-brief` skill, `retrieve.js`, FTS5 index (better-sqlite3), ranking pipeline 0-1 정규화 (F7), JSON+MD 출력, degraded paths (zero/stale/missing-profile) | 1.5일 |
| 5. Audit | `deep-memory-audit` skill, `audit.js`, schema validation + 3-pass redaction sample + stale memory + **stale lock detect + `--unlock`** + **`--promote <id>` (local → global, F9)** + redaction metadata 리포트 (high/zero risk) + source-rename detect + profile freshness 경고 | 1일 |
| 6. Tests + CI | 12 test suites (table 위), `npm test` 녹색, manifest-drift CI (strict YAML + 1024-char check), runtime-contract suite | 1.5일 |
| 7. Suite integration | `suite-extensions.json` + `marketplace.json` × 2 entry (deep-suite PR) | 0.5일 |
| 8. Handoff docs + spec finalize | `docs/handoff-phase-4-6.md`, `deep-work/docs/deep-memory-integration-handoff.md`, spec doc commit | 0.5일 |
| **합계** | | **~12.5 영업일** (Phase 3 분리 + atomic/lock/preflight/bridge 추가 보강 반영) |

각 Phase 종료 시 `npm test` 녹색 + 사용자 확인 게이트.

---

## 16. Out of scope (명시)

본 v0.1.0에서 의도적으로 제외 (대부분 handoff doc으로 인계). R1 review 반영으로 `--unlock`, `--promote <id>` 는 MVP 에 포함 (각각 D18, D15).

- semantic embedding / vector DB
- semantic dedupe (의미 같음, 표현 다름)
- LLM second-pass redaction (단, MVP 의 rule-based 는 3-pass 로 강화 — D17)
- team/org privacy scope (MVP 는 local + global 2단계만)
- 자동 SessionStart/Stop hook
- reasoning graph (`graph/nodes.jsonl`, `edges.jsonl`)
- `/deep-memory-audit --demote <id>`, `/deep-memory graph`, `/deep-memory rebuild`, `/deep-memory export-wiki`, `/deep-memory feedback` 명령 (단 `--unlock`, `--promote <id>` 는 MVP 포함)
- dashboard memory health metric 8종
- deep-review / deep-evolve writer integration (read-only consumer 만)
- deep-work brief auto-inject (deep-work 측 별도 PR)
- transactional 인덱스 보장 (MVP는 audit + rebuild 안내로 풀어감)
- decay / recency_weight (Mem0/LangMem 패턴, F26) — Phase 4+
- human discovery view (`/deep-memory-list`, F27) — Phase 4+ (단, `--promote` audit 출력에 카드 요약 포함)
- 1000+ cards backpressure (`--limit/--resume` 스트리밍, F28) — Phase 5+

---

## 17. Open questions (implementation 단계에서 결정)

R1 review 로 Q2/Q4 는 spec 으로 승격 (D16 / §6.1.a 참조). 남은 open question:

| Q | 옵션 | 결정 기준 |
|---|---|---|
| Q1. distill sub-agent 의 host model 선택 | (a) adapter-registry 가 자동 선택 (CC→claude-agent, Codex→codex-bash, etc.) (b) config로 명시 강제 | 기본 (a), config override 허용 (D19) |
| Q3. project_id 산출 시 monorepo sub-package 처리 | (a) git root 만 (b) `package.json` directory도 분리 | MVP는 (a) — Phase 4+에서 보강 |
| Q5. `stdin-fallback` adapter 의 사용자 UX | (a) 매 distill 마다 prompt (시끄러움) (b) batch 모드 (배치당 1회 prompt) | 기본 (b) (Phase 3b 에서 prototype 후 결정) |
| Q6. `--unlock` / `--promote` 의 확인 prompt 단계 | (a) AskUserQuestion (interactive) (b) `--yes` 플래그로 skip | (a) 기본, `--yes` 옵션 (CI 자동화) |

~~Q2 sqlite 의존성~~ → **D16 으로 승격** (better-sqlite3 pin, sql.js fallback).
~~Q4 evidence_summary 길이~~ → **§6.1.a 로 승격** (max 5 items, 각 ≤200 chars).

---

## 18. Spec self-review notes

**Round 1 deep-review-loop 결과 반영 (2026-05-20T12:33:52)**:
- 4-way 독립 리뷰 (Opus / Codex review / Codex adversarial / agy) → REQUEST_CHANGES, 14 🔴 / 11 🟡 / 6 ℹ️
- Round 2 응답: P1+P2+P3+P4+P5 + 핵심 yellows = 21 항목 spec 보강 적용 (사용자 선택 옵션 C)
- 핵심 회귀: §18 self-review 가 "internal consistency PASS" 라고 잘못 선언 → reviewer 들이 §6/§7/§9 의 `claim` origin + `avoid_when`/`non_applicability` 이름 불일치를 동시 적발

**False confidence 학습**: spec self-review 만으로는 multi-section field-name/origin consistency 검증이 부족. **외부 독립 리뷰 (1명 이상)** 가 spec 진입 전 필수. 이 학습은 `docs/handoff-phase-4-6.md` 의 "다음 단계 진입 전 closing 체크리스트" 에도 추가.

**Round 2 후 spec 상태**:

- [x] placeholder 없음 (TBD/TODO 모두 명시적 out-of-scope 또는 open question 처리)
- [x] internal consistency:
  - §6 schema ↔ §7 distill 필드 origin 정합 (R1 F1 fix — Step A 가 5 memory_type 모두 `claim` 채움)
  - §9 brief ↔ §6 schema 필드 이름 매핑 명시 (R1 F2 fix — `avoid_when ← non_applicability[].value`)
  - §8 score formula 모든 항 0-1 정규화 (R1 F7)
  - §10.2 config keys ↔ §8 score weights 일치
- [x] scope check: MVP가 단일 implementation plan으로 분해 가능 (~12.5 영업일, 10 phase)
- [x] ambiguity check:
  - `dedupe_key` normalize 규칙 (보수화, alphanumeric-only)
  - `applicability_seed_hash` 산출
  - status 전이 조건 (time-only deprecate)
  - redaction 3-pass 위치 + 패턴
  - lock metadata + stale detect (5min) + `--unlock` 명령
  - lease + idempotent event key (sha256)
  - cross-runtime adapter 5종 + auto-selection
- [x] correctness 보강 (R1 dedicated):
  - claim never-empty invariant (R1 F1)
  - atomic write + readback validate (R1 F3, F8)
  - concurrent harvest race 차단 (R1 F4)
  - LLM output JSON Schema validation (R1 F5)
  - 3-pass redaction (Step A in / Step B in / wrap, R1 F6)
  - source content_hash provenance (R1 F8)
  - global promote gate (사용자 명시 호출만, R1 F9)
  - NFS/symlink/read-only preflight (R1 F10)
  - cross-runtime adapter bridge (R1 F11) + runtime-contract tests (R1 F12)

---

## 19. References

- 기반 제안서: [`../deep-suite-cross-project-semantic-operational-memory-proposal.md`](../deep-suite-cross-project-semantic-operational-memory-proposal.md)
- 형제 플러그인 표본:
  - `/Users/sungmin/Dev/claude-plugins/deep-wiki/` (skills layout, manifest 패턴, lock 정책)
  - `/Users/sungmin/Dev/claude-plugins/deep-docs/` (가장 단순한 형제)
  - `/Users/sungmin/Dev/claude-plugins/deep-suite/` (메타 marketplace, schemas)
- M3 envelope schema: `deep-suite/schemas/artifact-envelope.schema.json`
- suite-extensions schema: `deep-suite/schemas/suite-extensions.schema.json`
