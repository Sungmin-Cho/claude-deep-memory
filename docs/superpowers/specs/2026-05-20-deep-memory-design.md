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
| D14 | Implementation = 8단계 ~9 영업일 | brainstorming 합의 |

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
│   │   ├── redact.js               # rule-based 1-pass redaction
│   │   ├── dedupe.js               # claim normalize + sha256
│   │   └── state-machine.js        # status 전이 (4 자동 + 1 수동)
│   └── lock.sh                     # mkdir-based
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
    ├── redaction.test.js           # known-secret invariant
    ├── dedupe.test.js
    ├── state-machine.test.js
    ├── manifest-drift.test.js      # 3중 version 동기 검증
    └── fixtures/
        ├── sample-recurring-findings.json
        ├── sample-evolve-insights.json
        ├── sample-session-receipt.json
        └── golden-cards/*.json
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
| `deep-memory-init` | true | `memory_root` + `config.yaml` + `project-profile.json` 생성 | 없음 (auto-detect) 또는 `<memory_root>` | `~/.deep-memory/config.yaml`, `.deep-memory/project-profile.json` |
| `deep-memory-harvest` | true | project artifact 스캔 → events JSONL → distill (Step B 자동) → cards 저장 | 없음 (전체) 또는 `<artifact-path>` | `~/.deep-memory/events/YYYY-MM.jsonl`, `~/.deep-memory/cards/<type>/*.json`, `.deep-memory/latest-harvest.json` |
| `deep-memory-brief` | true | task 텍스트에 대한 top-N memory brief | `"<task description>"` | `.deep-memory/latest-brief.json`, `.deep-memory/latest-brief.md` |
| `deep-memory-audit` | true | schema validation + redaction sample check + stale memory report + state transition | 없음 | `.deep-memory/latest-audit.json` (콘솔 표시) |
| `memory-schema` | **false** | M3 envelope, card schema, state machine, dedupe 규칙의 단일 진실 — 다른 4개 skill이 inline reference | — | — |

**제약**:
- 모든 user-invocable skill의 frontmatter `description` ≤ 1024자 (Codex strict 한계, 제안서 §16에서 deep-evolve가 이미 겪었던 함정).
- Codex strict YAML — description에 `colon-space` 패턴 (예: `Use: when ...`) 금지 또는 인용. deep-wiki v1.6.1 사례.

---

## 6. Memory Card Schema

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
        { "path": ".deep-review/recurring-findings.json", "run_id": "01H..." }
      ],
      "tool_versions": { "node": "22.x" }
    }
  },
  "payload": {
    "memory_id": "mem_failure_8f42a1",
    "memory_type": "failure-case",
    "dedupe_key": "sha256:abc123...",
    "title": "Codex skill discovery can silently fail on invalid skill metadata",
    "claim": "When migrating slash commands to Codex skills, strict metadata constraints can cause skills to be silently dropped unless manifest and skill frontmatter are validated.",
    "evidence_summary": [
      "deep-evolve trimmed skill description below Codex limit",
      "deep-wiki fixed frontmatter YAML parsing issue"
    ],
    "applicability": ["command-to-skill migration", "Codex plugin compatibility"],
    "non_applicability": ["Claude Code slash-command-only plugin"],
    "recommended_action": [
      "Add manifest drift tests",
      "Run skill-reviewer against every user-invocable skill",
      "Validate YAML frontmatter strictly"
    ],
    "confidence": 0.86,
    "status": "validated",
    "status_history": [
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
    }
  }
}
```

### 6.2 `dedupe_key` 산출

```text
dedupe_key = "sha256:" + sha256(
  memory_type + "|" + normalize(claim)
)
normalize(text):
  - lowercase
  - collapse whitespace to single space
  - strip punctuation [.,;:!?'"()\[\]{}]
  - remove tokens in stop-set {"the","a","an","is","of","to","for","when","that"}
  - trim
```

충돌 시 동작:
1. 기존 card의 `last_seen_at` 갱신.
2. 신규 `evidence_summary` 항목을 기존과 union (중복 제거).
3. `confidence` 재계산: `min(1.0, existing_confidence + 0.05 × new_evidence_count)`.
4. `applicability` / `non_applicability` / `tags` 도 union.
5. `recommended_action` 은 기존 유지 (덮어쓰지 않음).

semantic dedupe (의미는 같지만 표현이 다름) 은 Phase 4+ 로 이연 — embedding 도입 시점.

### 6.3 Status state machine

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
   review_after age │              │ new_supporting>=2
   AND not reused   │              │
   90d              ▼              ▼
                ┌──────────┐  (back to candidate)
                │deprecated│
                └──────────┘

manual: /deep-memory promote <id> | /deep-memory demote <id>
        (MVP에서는 audit 단계의 콘솔 안내만 — promote/demote 명령은 Phase 4+)
```

자동 전이는 `deep-memory-audit` 실행 시에만 평가 (실시간 X). 모든 전이는 `status_history`에 `{from, to, at, by}` 로 기록.

### 6.4 Conflict resolution policy

두 card가 같은 `dedupe_key` 지만 `claim` / `applicability` 가 의미상 다를 때 (rule-based normalize는 같게 만들지만 사용자가 보기엔 다른 경우):

- **last_seen_at 신순** + **evidence_summary union** + **status는 더 보수적인 쪽** (`candidate > validated > contradicted > deprecated`) → 추후 사람 판단 보류.
- audit 단계에서 `dedupe_collision` 리포트로 노출.

---

## 7. Distill pipeline (Hybrid)

### 7.1 Step A — Rule-based extraction (deterministic)

| Source artifact | Memory type | 매핑 규칙 |
|---|---|---|
| `.deep-review/recurring-findings.json` | `failure-case` | `finding.title → title`, `finding.evidence → evidence_summary[]`, `finding.tags → tags`, `finding.first_seen → created_at` |
| `.deep-evolve/*/evolve-insights.json` | `experiment-outcome` | `insight.strategy → claim`, `insight.q_delta` (0~1 normalize) `→ confidence`, `insight.project_signature → applicability seed` |
| `.deep-work/*/session-receipt.json` | `pattern` (성공 slice) / `failure-case` (실패 slice) | slice outcome 기반 분기, slice_id를 `evidence_summary`에 |
| `.deep-docs/last-scan.json` | `coding-style` | doc drift finding → style rule candidate |
| `<wiki_root>/.wiki-meta/index.json` | `architecture-decision` | `page.frontmatter.adr=true` 인 페이지만 → ADR seed |

Step A 산출: `event-draft.json` (필수 필드 채워짐, 일부 미정 가능). `~/.deep-memory/events/YYYY-MM.jsonl` 에 envelope-wrapped event append.

### 7.2 Step B — LLM sub-agent refinement (graceful)

- **Sub-agent**: `agents/memory-distiller.md`
  - Role: Read-only (Write 없음, Edit 없음)
  - Input: event-draft + source artifact 발췌 (최대 4096 bytes)
  - Task: 빈 칸만 채움 — `claim` 정제, `non_applicability` 추론, `recommended_action` 합성
  - Output: 완성된 card payload
- **Invariant**: Step A가 채운 필드는 sub-agent가 절대 덮어쓰지 않음 (test로 검증).
- **Timeout**: `config.yaml` 의 `distill.llm.timeout_ms` (기본 30000ms).
- **Fallback** (host LLM 미가용 / timeout / parse error):
  - card 저장하되 `status: candidate`, `confidence: 0.4`, 미완성 필드는 빈 배열.
  - `audit` 단계의 `incomplete_cards` 리포트에 노출.

### 7.3 Step C — Persist (lock 보호)

1. mkdir-based lock 획득 (`~/.deep-memory/.lock/` 디렉토리 생성으로 atomic).
2. `dedupe_key` 충돌 검사 → 신규/병합 결정 (§6.2).
3. card 파일 저장 (`~/.deep-memory/cards/<type>/<memory_id>.json`).
4. `events/YYYY-MM.jsonl` 에 envelope-wrapped event append.
5. `indexes/lexical.sqlite` 의 FTS5 테이블에 (claim + applicability + tags) 인덱싱.
6. lock 해제.

부분 실패 시 (e.g., card 저장 후 sqlite 인덱싱 실패): card는 유지, 다음 `audit` 에서 `index_orphan` 으로 감지하고 `deep-memory-audit --rebuild-index` 안내. **MVP는 transactional 보장 X** — 보수적으로 audit + rebuild 안내로 풀어감 (Phase 5에서 `deep-memory-rebuild` 명령 신설).

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

최종 score:
```
score = w1 · project_sim + w2 · task_sim + w3 · evidence_quality
        − w4 · stale_penalty(review_after)
w1=0.2, w2=0.5, w3=0.3, w4=0.1 (config.yaml에서 override)
```

`top_n` (기본 8) 만 반환.

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

**불변 (검토 H4 응답)** — 각 memory 출력에 항상 포함:
- `claim` / `why_relevant` / `evidence_paths` / `recommended_action` / `avoid_when`

`why_relevant`와 `avoid_when`이 비어 있으면 brief 생성 자체를 실패시킴 (test로 검증). agent가 memory를 맹신하지 않도록 강제.

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
  - kind: review-recurring
    path: ".deep-review/recurring-findings.json"
    memory_type: failure-case
  - kind: evolve-insights
    path: ".deep-evolve/*/evolve-insights.json"
    memory_type: experiment-outcome
  - kind: work-receipt
    path: ".deep-work/*/session-receipt.json"
    memory_type: pattern
  - kind: docs-scan
    path: ".deep-docs/last-scan.json"
    memory_type: coding-style
  - kind: wiki-index
    path: "<wiki_root>/.wiki-meta/index.json"
    memory_type: architecture-decision
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

### 11.1 Rule-based 1-pass (MVP)

`scripts/lib/redact.js` 가 다음 패턴을 모든 event/card 산출 전에 mask:

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
```

### 11.3 CI invariant test

`tests/redaction.test.js` — known-secret fixture (`tests/fixtures/dangerous-secrets.json`) 을 harvest 입력으로 던져서, 산출 event / card / brief 그 어디에도 매치되지 않음을 검증. CI 게이트.

### 11.4 LLM second-pass (Phase 4+)

MVP는 rule-based 1-pass만. false-negative는 audit 시 콘솔에 경고 (LLM second-pass는 handoff doc 참조).

---

## 12. Testing strategy

| Test | 목적 | 파일 |
|---|---|---|
| envelope-emit | 모든 산출 artifact가 M3 envelope-wrapped + `producer:deep-memory` + schema 유효 | `tests/envelope-emit.test.js` |
| harvest-golden | rule-based extraction 결정성 — 같은 fixture → 같은 event | `tests/harvest-golden.test.js` |
| distill-golden | Hybrid distill 회귀 차단 (LLM Step B mock) | `tests/distill-golden.test.js` |
| redaction | 알려진 secret이 모든 산출에서 제거 | `tests/redaction.test.js` |
| dedupe | 같은 claim 두 번 → card 1개 + union | `tests/dedupe.test.js` |
| state-machine | 4 자동 + 1 수동 전이 정확성 | `tests/state-machine.test.js` |
| manifest-drift | `.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `package.json` version 3중 동기 | `tests/manifest-drift.test.js` |

`npm test` 단일 명령으로 전체 실행. Node 22 LTS, `node --test` runner.

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

| Phase | 산출 | 추정 |
|---|---|---|
| 0. Skeleton | `git init` (완료), `.gitignore`, plugin.json × 2, CLAUDE.md, AGENTS.md, README × 2, LICENSE, package.json, 첫 commit | 0.5일 |
| 1. Schemas + scripts/lib | `envelope.js`, `redact.js`, `dedupe.js`, `state-machine.js`, `lock.sh`, `schemas/*.json` | 1일 |
| 2. Harvest | `deep-memory-init` + `deep-memory-harvest` skills, `harvest.js`, event JSONL emit, redaction 통과 | 1.5일 |
| 3. Distill | `memory-distiller.md` sub-agent, `distill.js` Step A+B+fallback, golden eval harness | 2일 |
| 4. Brief | `deep-memory-brief` skill, `retrieve.js`, FTS5 index, ranking pipeline, JSON+MD 출력 | 1.5일 |
| 5. Audit | `deep-memory-audit` skill, `audit.js`, schema validation + redaction sample + stale report | 0.5일 |
| 6. Tests + CI | 7 test suites, `npm test` 녹색, manifest-drift CI | 1일 |
| 7. Suite integration | `suite-extensions.json` + `marketplace.json` × 2 entry (deep-suite PR) | 0.5일 |
| 8. Handoff docs + spec finalize | `docs/handoff-phase-4-6.md`, `deep-work/docs/deep-memory-integration-handoff.md`, spec doc commit | 0.5일 |
| **합계** | | **~9 영업일** |

각 Phase 종료 시 `npm test` 녹색 + 사용자 확인 게이트.

---

## 16. Out of scope (명시)

본 v0.1.0에서 의도적으로 제외 (대부분 handoff doc으로 인계):

- semantic embedding / vector DB
- semantic dedupe (의미 같음, 표현 다름)
- LLM second-pass redaction
- team/org privacy scope
- 자동 SessionStart/Stop hook
- reasoning graph (`graph/nodes.jsonl`, `edges.jsonl`)
- `/deep-memory graph`, `/deep-memory promote`, `/deep-memory demote`, `/deep-memory rebuild`, `/deep-memory export-wiki`, `/deep-memory feedback` 명령
- dashboard memory health metric 8종
- deep-review / deep-evolve writer integration (read-only consumer 만)
- deep-work brief auto-inject (deep-work 측 별도 PR)
- transactional 인덱스 보장 (MVP는 audit + rebuild 안내로 풀어감)

---

## 17. Open questions (implementation 단계에서 결정)

다음은 spec에서 굳히지 않고 implementation 단계에서 결정 권장:

| Q | 옵션 | 결정 기준 |
|---|---|---|
| Q1. distill sub-agent의 model 선택 | (a) host LLM 자동 (CC=Claude, Codex=GPT) (b) config로 명시 | 기본 (a), config override 허용 |
| Q2. sqlite 의존성 | (a) `better-sqlite3` (b) `sql.js` (WASM) (c) bash + `sqlite3` CLI | 기본 (a) — node-native, 형제 일관 |
| Q3. project_id 산출 시 monorepo sub-package 처리 | (a) git root만 (b) `package.json` directory도 분리 | MVP는 (a) — Phase 4+에서 보강 |
| Q4. `evidence_summary` 의 길이 한계 | (a) 무제한 (b) 항목당 200자, 최대 5개 | (b) 권장 (token cost 통제) |

---

## 18. Spec self-review notes

Implementation 진입 전 다음 항목들이 verified:

- [x] placeholder 없음 (TBD/TODO 모두 명시적 out-of-scope 또는 open question 처리)
- [x] internal consistency: §6 schema와 §7 distill의 필드 일치 / §8 retrieval 가중치와 §10.2 config 일치
- [x] scope check: MVP가 단일 implementation plan으로 분해 가능 (~9 영업일, 8 phase)
- [x] ambiguity check: `dedupe_key` normalize 규칙, status 전이 조건, redaction 패턴 모두 explicit

---

## 19. References

- 기반 제안서: [`../deep-suite-cross-project-semantic-operational-memory-proposal.md`](../deep-suite-cross-project-semantic-operational-memory-proposal.md)
- 형제 플러그인 표본:
  - `/Users/sungmin/Dev/claude-plugins/deep-wiki/` (skills layout, manifest 패턴, lock 정책)
  - `/Users/sungmin/Dev/claude-plugins/deep-docs/` (가장 단순한 형제)
  - `/Users/sungmin/Dev/claude-plugins/deep-suite/` (메타 marketplace, schemas)
- M3 envelope schema: `deep-suite/schemas/artifact-envelope.schema.json`
- suite-extensions schema: `deep-suite/schemas/suite-extensions.schema.json`
