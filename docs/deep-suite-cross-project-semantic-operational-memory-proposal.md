# Deep Suite: Cross-project Semantic Operational Memory 개선 제안서

작성일: 2026-05-19  
대상 저장소: [`Sungmin-Cho/claude-deep-suite`](https://github.com/Sungmin-Cho/claude-deep-suite)

---

## 1. 결론

현재 `deep-suite`는 단순한 플러그인 묶음이 아니라, 구조화된 개발 프로토콜, 지식 관리, 자율 실험, 독립 리뷰, 문서 정합성 관리, harness 진단을 하나로 묶은 **cross-runtime plugin marketplace** 구조다.

현재 구성은 다음 6개 플러그인으로 이루어져 있다.

| Plugin | 역할 |
|---|---|
| `deep-work` | Evidence-Driven Development Protocol |
| `deep-wiki` | LLM-managed markdown wiki |
| `deep-evolve` | Autonomous Experimentation Protocol |
| `deep-review` | Independent Evaluator |
| `deep-docs` | Document gardening agent |
| `deep-dashboard` | Cross-plugin harness diagnostics + suite telemetry |

다음 단계인 **Cross-project Semantic Operational Memory**는 `deep-wiki`를 단순히 확장하는 것보다, 새로운 7번째 플러그인인 **`deep-memory`**로 분리하는 것이 가장 적합하다.

추천 구조는 다음과 같다.

```text
deep-wiki
= project-local persistent knowledge base

deep-memory
= cross-project semantic operational memory + reasoning graph
```

즉, `deep-wiki`는 프로젝트 내부 지식의 축적 계층으로 유지하고, `deep-memory`는 프로젝트 간 재사용 가능한 판단 단위인 **pattern / failure / decision / experiment / style / graph**를 관리하는 계층으로 분리하는 것이 좋다.

---

## 2. 현재 deep-suite 구조의 강점

### 2.1 Cross-runtime marketplace 구조

현재 `deep-suite`는 Claude Code와 Codex 양쪽을 지원한다.

```text
Claude Code
  → .claude-plugin/marketplace.json

Codex
  → .agents/plugins/marketplace.json
  → each plugin's .codex-plugin/plugin.json
  → skills/<skill>/SKILL.md
```

이 구조는 단일 런타임에 묶이지 않고, Claude Code / Codex / Copilot CLI / Gemini CLI / Agent SDK 등으로 확장 가능한 기반을 제공한다.

### 2.2 Sidecar manifest 기반 cross-plugin metadata

`.claude-plugin/suite-extensions.json`은 각 플러그인의 다음 정보를 선언한다.

```text
runtime
capabilities
artifacts.writes
artifacts.reads
hooks_active
data_flow
```

즉 deep-suite는 이미 플러그인 간 artifact 흐름을 표현하는 **sidecar manifest**를 갖고 있다.

현재 data flow 예시는 다음과 같다.

```text
deep-work      → deep-review      via session-receipt
deep-work      → deep-dashboard   via session-receipt + harness-sessions.jsonl
deep-docs      → deep-dashboard   via last-scan.json
deep-evolve    → deep-dashboard   via evolve-receipt
deep-evolve    → deep-work        via evolve-insights
deep-dashboard → deep-work        via harnessability-report.json
deep-review    → deep-evolve      via recurring-findings.json
deep-wiki      → deep-work        via index.json
```

이 구조는 `deep-memory`를 추가하기에 매우 좋은 기반이다.

### 2.3 M3 Artifact Envelope

현재 deep-suite는 cross-plugin JSON artifact에 공통 envelope를 적용한다.

공통 envelope는 다음 요소를 포함한다.

```text
producer
producer_version
artifact_kind
run_id
session_id
parent_run_id
generated_at
schema
git
provenance
payload
```

이 구조는 cross-plugin trace, schema drift detection, aggregation freshness, producer attribution, reproducibility를 가능하게 한다.

`deep-memory`는 이 envelope를 그대로 재사용해야 한다.

---

## 3. 현재 구조의 한계

현재 deep-suite는 프로젝트 내부 흐름에는 강하다.

예를 들어 `deep-work`는 다음 흐름으로 동작한다.

```text
Brainstorm
→ Research
→ Plan
→ Implement
→ Test
→ Integrate
```

그리고 Phase 5 Integrate에서는 여러 플러그인의 artifact를 읽어 다음 작업을 추천한다.

```text
session-receipt
recurring-findings
fitness.json
harnessability-report
last-scan
evolve-insights
wiki index
git diff
```

하지만 사용자가 원하는 다음 단계는 단순히 현재 프로젝트 안에서 artifact를 연결하는 것이 아니다.

목표는 다음이다.

```text
A 프로젝트에서 겪은 실패가
B 프로젝트의 계획 단계에서 자동으로 떠오르고,

C 프로젝트의 아키텍처 결정이
D 프로젝트의 리팩토링 판단에 참고되고,

E 프로젝트에서 성공한 실험 전략이
F 프로젝트의 deep-evolve 초기 전략으로 주입되고,

여러 프로젝트에서 반복되는 코드 스타일 변화가
조직 차원의 engineering rule로 승격되는 것
```

현재 구조는 artifact-level memory에는 강하지만, 다음과 같은 semantic memory abstraction은 아직 부족하다.

```text
pattern
failure-case
architecture-decision
experiment-outcome
coding-style
organization reasoning graph
```

따라서 다음 단계는 단순 RAG나 wiki 확장이 아니라, **운영 경험을 semantic memory object로 컴파일하는 계층**이어야 한다.

---

## 4. 제안: 7번째 플러그인 `deep-memory`

### 4.1 역할 정의

`deep-memory`는 다음 역할을 담당한다.

```text
각 프로젝트의 deep-suite artifact를 수집
→ reusable operational memory로 추출
→ 중복 제거 / 검증 / 상태 관리
→ 프로젝트 간 graph relation 구성
→ 작업 시작 시 task-specific memory brief 제공
```

### 4.2 deep-wiki와의 차이

| 항목 | deep-wiki | deep-memory |
|---|---|---|
| 주 목적 | 프로젝트 내부 지식 축적 | 프로젝트 간 운영 경험 재사용 |
| 저장 단위 | Markdown page | Memory card + graph node |
| 주요 사용자 | 사람 + LLM | LLM harness + dashboard |
| 형식 | human-readable | machine-readable + exportable |
| 범위 | project-local | cross-project / optional org-wide |
| 핵심 질문 | “무엇을 알게 되었나?” | “다음 작업에서 어떤 경험을 재사용해야 하나?” |

### 4.3 핵심 Memory Type

`deep-memory`는 아래 6가지 memory type을 관리하는 것이 좋다.

| Memory Type | 설명 | 예시 |
|---|---|---|
| `pattern` | 프로젝트 간 반복적으로 성공한 구현/설계 패턴 | “CLI 플러그인은 command → skill migration 시 manifest drift test가 필요하다” |
| `failure-case` | 반복 실패, 리뷰 지적, regression 사례 | “YAML frontmatter description에 colon-space가 있으면 Codex strict parser가 skill을 누락할 수 있다” |
| `architecture-decision` | ADR, 설계 선택, trade-off, lineage | “marketplace schema가 closed라 suite-only metadata는 sidecar로 분리했다” |
| `experiment-outcome` | deep-evolve 실험 결과, Q 변화, keep/discard 이유 | “virtual N-seed exploration은 평가 병렬성이 높은 프로젝트에서 효과적” |
| `coding-style` | 코드 스타일과 convention의 시간적 변화 | “bash script는 BSD/GNU stat 차이를 테스트해야 한다” |
| `org-reasoning-graph` | 프로젝트/패턴/결정/실패/실험 간 관계 그래프 | “M3 envelope → dashboard telemetry → Phase 5 recommendation quality 개선” |

---

## 5. 전체 아키텍처

### 5.1 High-level Architecture

```text
각 프로젝트의 deep-suite artifacts
  ├─ .deep-work/**
  ├─ .deep-review/**
  ├─ .deep-evolve/**
  ├─ .deep-docs/**
  ├─ .deep-dashboard/**
  └─ <wiki_root>/.wiki-meta/**

        ↓ harvest

project-local memory events
  └─ .deep-memory/events/*.jsonl

        ↓ distill / dedupe / validate

global operational memory
  └─ ~/.claude/deep-suite/memory/
       ├─ cards/
       │   ├─ patterns/
       │   ├─ failures/
       │   ├─ decisions/
       │   ├─ experiments/
       │   └─ style/
       ├─ graph/
       │   ├─ nodes.jsonl
       │   └─ edges.jsonl
       ├─ indexes/
       │   ├─ lexical.sqlite
       │   └─ semantic.sqlite or vectors/
       └─ snapshots/

        ↓ retrieve

task-specific memory brief
  └─ .deep-memory/latest-brief.json
  └─ .deep-memory/latest-brief.md

        ↓ consume

deep-work / deep-review / deep-evolve / deep-docs / deep-dashboard
```

### 5.2 핵심 설계 원칙

`deep-memory`는 원본 artifact를 그대로 vector DB에 넣는 방식이면 안 된다. 그렇게 하면 단순히 “프로젝트 간 RAG”가 된다.

권장 흐름은 다음과 같다.

```text
raw artifacts
  → operational extraction
  → memory card
  → graph relation
  → evidence validation
  → task-specific brief
```

즉, 검색 가능한 원문 저장소가 아니라 **판단 가능한 기억 단위**로 변환해야 한다.

---

## 6. Memory Card Schema 제안

모든 memory card는 M3 artifact envelope를 재사용해야 한다.

예시:

```json
{
  "$schema": "https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json",
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-memory",
    "producer_version": "0.1.0",
    "artifact_kind": "memory-card",
    "run_id": "01H...",
    "generated_at": "2026-05-19T00:00:00Z",
    "schema": {
      "name": "memory-card",
      "version": "1.0"
    },
    "git": {
      "head": "0000000",
      "branch": "global-memory",
      "dirty": "unknown"
    },
    "provenance": {
      "source_artifacts": [
        {
          "path": ".deep-review/recurring-findings.json",
          "run_id": "01H..."
        },
        {
          "path": ".deep-work/20260519-xxx/session-receipt.json",
          "run_id": "01H..."
        }
      ],
      "tool_versions": {
        "node": "20.x"
      }
    }
  },
  "payload": {
    "memory_id": "mem_failure_8f42a1",
    "memory_type": "failure-case",
    "title": "Codex skill discovery can silently fail on invalid skill metadata",
    "claim": "When migrating slash commands to Codex skills, strict metadata constraints can cause skills to be silently dropped unless manifest and skill frontmatter are validated.",
    "evidence_summary": [
      "deep-evolve trimmed skill description below Codex limit",
      "deep-wiki fixed frontmatter YAML parsing issue"
    ],
    "applicability": [
      "command-to-skill migration",
      "Codex plugin compatibility",
      "multi-runtime marketplace"
    ],
    "non_applicability": [
      "Claude Code slash-command-only plugin"
    ],
    "recommended_action": [
      "Add manifest drift tests",
      "Run skill-reviewer against every user-invocable skill",
      "Validate YAML frontmatter strictly"
    ],
    "confidence": 0.86,
    "status": "validated",
    "tags": ["codex", "skills", "manifest", "plugin-migration"],
    "created_at": "2026-05-19T00:00:00Z",
    "last_seen_at": "2026-05-19T00:00:00Z",
    "review_after": "2026-08-19T00:00:00Z"
  }
}
```

### 6.1 중요한 필드

| Field | 역할 |
|---|---|
| `memory_id` | memory card 고유 ID |
| `memory_type` | pattern / failure-case / decision / experiment / style |
| `claim` | 재사용 가능한 핵심 주장 |
| `evidence_summary` | 근거 요약 |
| `applicability` | 적용 가능한 조건 |
| `non_applicability` | 적용하면 안 되는 조건 |
| `recommended_action` | 다음 작업에 반영할 행동 |
| `confidence` | 신뢰도 |
| `status` | candidate / validated / contradicted / deprecated |
| `review_after` | memory freshness 점검 시점 |

특히 `non_applicability`가 중요하다. memory가 과잉 적용되면 agent 품질이 나빠질 수 있다.

---

## 7. Organization-wide Reasoning Graph

`deep-memory`는 card만 저장하면 부족하다. card 간 관계를 graph로 연결해야 한다.

### 7.1 Node Types

```text
Project
Plugin
Artifact
Pattern
FailureCase
ArchitectureDecision
ExperimentOutcome
CodingStyleRule
ReviewFinding
Handoff
Metric
```

### 7.2 Edge Types

```text
DERIVED_FROM
VALIDATED_BY
CONTRADICTED_BY
SUPERSEDES
USED_IN
FAILED_IN
TRANSFERRED_TO
CAUSED_BY
MITIGATED_BY
RECOMMENDED_FOR
AVOID_IN
```

### 7.3 예시

```text
ArchitectureDecision: "Use sidecar manifest for suite-only metadata"
  DERIVED_FROM → marketplace schema closed constraint
  USED_IN → claude-deep-suite
  VALIDATED_BY → suite-extensions validator
  ENABLED → cross-plugin data_flow documentation
```

```text
FailureCase: "skill description over 1024 chars can be dropped by Codex"
  FAILED_IN → deep-evolve v3.4.0
  MITIGATED_BY → description length guard
  RECOMMENDED_FOR → all future skill migration tasks
```

### 7.4 가능해지는 Query

```text
“새 플러그인을 Codex compatible하게 만들 때 과거 실패 사례를 알려줘”

“architecture decision lineage에서 sidecar manifest를 선택한 이유는?”

“이 프로젝트와 유사한 프로젝트에서 deep-evolve가 성공한 strategy는?”

“최근 3개월 동안 coding style이 어떻게 바뀌었나?”
```

---

## 8. 기존 플러그인별 통합 제안

### 8.1 deep-work 통합

`deep-work`는 가장 중요한 consumer다.

제안:

```text
Phase 1 Research 시작 시:
1. 현재 task, repo profile, changed files, topology 추출
2. /deep-memory brief "<task>" 호출
3. 관련 memory top 5~10개 조회
4. Research artifact에 "Cross-project Memory" 섹션 추가
```

brief 예시:

```md
## Cross-project Memory Brief

### 1. Related failure cases

- Codex skill discovery can fail on invalid frontmatter.
  - Applicability: command-to-skill migration
  - Recommended action: run strict YAML validation + skill-reviewer
  - Avoid when: Claude Code slash-command-only plugin

### 2. Related architecture decisions

- Use sidecar manifest when official marketplace schema is closed.
  - Reason: avoids plugin validator rejection
  - Evidence: suite-extensions schema and validator

### 3. Related coding style rules

- For cross-platform shell scripts, test BSD/GNU command differences.
```

Phase 5 top-3 후보에도 다음을 추가할 수 있다.

```bash
/deep-memory harvest .deep-work/<session>
```

### 8.2 deep-review 통합

`deep-review`는 failure memory의 가장 좋은 producer다.

현재 흐름:

```text
deep-review
  → recurring-findings.json
  → deep-evolve
```

확장 흐름:

```text
deep-review
  → recurring-findings.json
  → deep-memory harvest
  → failure-case card
  → future deep-review rule suggestion
```

`deep-review`는 consumer로도 활용할 수 있다.

```text
리뷰 시작 시:
- 현재 diff와 관련된 failure-case memory 검색
- coding-style memory 검색
- architecture decision lineage 검색
- 리뷰 기준에 주입
```

그러면 리뷰가 단순히 현재 코드 품질을 보는 것이 아니라, **조직의 과거 실패를 반영한 리뷰어**가 된다.

### 8.3 deep-evolve 통합

`deep-evolve`에는 이미 cross-project meta-archive 개념이 있다. 이를 `deep-memory`와 연결하면 좋다.

```text
deep-evolve meta-archive
= strategy transfer 중심

deep-memory experiment-outcome
= 어떤 실험이 어떤 조건에서 성공/실패했는지의 semantic record
```

예시:

```json
{
  "memory_type": "experiment-outcome",
  "goal": "increase test coverage",
  "project_signature": {
    "language": "typescript",
    "test_framework": "vitest",
    "topology": "plugin"
  },
  "strategy": "start with manifest drift tests before behavior tests",
  "outcome": "improved coverage and caught Codex compatibility regressions",
  "q_delta": 0.18,
  "transferability": "high",
  "avoid_when": [
    "project has no plugin manifest",
    "tests are not executable locally"
  ]
}
```

### 8.4 deep-docs 통합

`deep-docs`는 architecture decision lineage와 잘 맞는다.

추가 가능 기능:

```text
- 과거 ADR과 현재 문서가 충돌하는지 감지
- 같은 설계 결정이 여러 프로젝트 README에 다르게 설명되는지 감지
- organization-level convention 문서와 project docs 불일치 감지
```

예시 memory:

```text
ArchitectureDecision:
"All plugins must expose Codex skills under skills/<skill>/SKILL.md"
```

이 memory가 있으면 `deep-docs`가 각 플러그인의 README, AGENTS.md, plugin.json을 검사할 때 더 정확한 기준을 가질 수 있다.

### 8.5 deep-wiki 통합

`deep-wiki`는 `deep-memory`의 원천이자 결과 표시 계층이 될 수 있다.

추천 구조:

```text
deep-wiki → deep-memory
- project wiki pages에서 architecture decision, pattern, glossary 추출

deep-memory → deep-wiki
- 검증된 memory card를 human-readable global wiki page로 export
```

예시 명령:

```bash
/deep-memory export-wiki --type architecture-decision
/wiki-ingest ~/.claude/deep-suite/memory/exports/architecture-decisions.md
```

### 8.6 deep-dashboard 통합

`deep-dashboard`는 memory 품질을 측정해야 한다.

추가 metric 제안:

| Metric | 의미 |
|---|---|
| `suite.memory.cards_total` | 누적 memory card 수 |
| `suite.memory.validated_ratio` | 검증된 memory 비율 |
| `suite.memory.stale_ratio` | `review_after`가 지난 memory 비율 |
| `suite.memory.reuse_rate` | task brief에 사용된 memory 비율 |
| `suite.memory.false_positive_rate` | 사용자가 “관련 없음”으로 reject한 memory 비율 |
| `suite.memory.cross_project_transfer_count` | 프로젝트 간 실제 재사용 횟수 |
| `suite.memory.decision_lineage_completeness` | ADR lineage가 source artifact와 연결된 비율 |
| `suite.memory.graph_orphan_ratio` | 연결 없는 memory node 비율 |

이렇게 해야 memory가 많아지는 것이 아니라, **쓸모 있는 memory가 유지되는지**를 볼 수 있다.

---

## 9. Marketplace 구조 변경안

### 9.1 `.claude-plugin/marketplace.json`

```json
{
  "name": "deep-memory",
  "description": "Cross-project semantic operational memory — harvests deep-suite artifacts, distills reusable patterns/failures/decisions/experiment outcomes, and injects task-specific memory briefs into future work.",
  "source": {
    "source": "url",
    "url": "https://github.com/Sungmin-Cho/claude-deep-memory.git",
    "sha": "<pinned-sha>"
  }
}
```

### 9.2 `.agents/plugins/marketplace.json`

```json
{
  "name": "deep-memory",
  "source": {
    "source": "url",
    "url": "https://github.com/Sungmin-Cho/claude-deep-memory.git",
    "sha": "<pinned-sha>"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_USE"
  },
  "category": "Productivity"
}
```

### 9.3 `.claude-plugin/suite-extensions.json`

```json
"deep-memory": {
  "runtime": ["node", "bash"],
  "capabilities": [
    "cross-project-memory",
    "semantic-retrieval",
    "decision-lineage",
    "failure-reuse",
    "experiment-outcome-memory",
    "memory-audit"
  ],
  "artifacts": {
    "writes": [
      ".deep-memory/project-profile.json",
      ".deep-memory/latest-brief.json",
      ".deep-memory/latest-harvest.json",
      "<memory_root>/events/*.jsonl",
      "<memory_root>/cards/**/*.json",
      "<memory_root>/graph/nodes.jsonl",
      "<memory_root>/graph/edges.jsonl"
    ],
    "reads": [
      ".deep-work/**",
      ".deep-review/**",
      ".deep-evolve/**",
      ".deep-docs/**",
      ".deep-dashboard/**",
      "<wiki_root>/.wiki-meta/**",
      "<wiki_root>/log.jsonl"
    ]
  },
  "hooks_active": [],
  "hooks_intentionally_empty_reason": "Cross-project memory는 privacy와 trust boundary가 중요하므로 초기 버전에서는 user-invocation 기반으로만 harvest/retrieve를 수행한다."
}
```

### 9.4 data_flow 추가

```json
{ "from": "deep-work", "to": "deep-memory", "via": "session-receipt + report + handoff" },
{ "from": "deep-review", "to": "deep-memory", "via": "recurring-findings + review reports" },
{ "from": "deep-evolve", "to": "deep-memory", "via": "evolve-receipt + evolve-insights + forum" },
{ "from": "deep-docs", "to": "deep-memory", "via": "last-scan + doc drift findings" },
{ "from": "deep-wiki", "to": "deep-memory", "via": "index.json + log.jsonl" },
{ "from": "deep-memory", "to": "deep-work", "via": "latest-brief.json" },
{ "from": "deep-memory", "to": "deep-review", "via": "failure/style memory brief" },
{ "from": "deep-memory", "to": "deep-evolve", "via": "experiment-outcome candidates" },
{ "from": "deep-memory", "to": "deep-dashboard", "via": "memory-health metrics" }
```

---

## 10. Command / Skill Surface 제안

처음부터 skill-first로 설계하는 것이 좋다.

### 10.1 Claude Code

```bash
/deep-memory init
/deep-memory harvest
/deep-memory harvest .deep-work/<session-id>/
/deep-memory brief "implement Codex-compatible plugin manifest"
/deep-memory query "What failures happened during command-to-skill migration?"
/deep-memory graph "sidecar manifest decision lineage"
/deep-memory audit
/deep-memory promote <memory-id>
/deep-memory demote <memory-id>
/deep-memory export-wiki
```

### 10.2 Codex

```bash
$deep-memory:deep-memory init
$deep-memory:deep-memory harvest
$deep-memory:deep-memory brief "implement Codex-compatible plugin manifest"
$deep-memory:deep-memory query "What failures happened during command-to-skill migration?"
```

### 10.3 MVP 핵심 명령 3개

초기 MVP에서는 아래 3개만 있어도 된다.

```bash
/deep-memory harvest
/deep-memory brief "<task>"
/deep-memory audit
```

---

## 11. 저장소 구조 제안

### 11.1 Global Memory Root

```text
~/.claude/deep-suite/memory/
├── config.yaml
├── projects/
│   ├── <project-id>.json
│   └── aliases.json
├── events/
│   ├── 2026-05.jsonl
│   └── 2026-06.jsonl
├── cards/
│   ├── patterns/
│   │   └── mem_pattern_<hash>.json
│   ├── failures/
│   │   └── mem_failure_<hash>.json
│   ├── decisions/
│   │   └── mem_decision_<hash>.json
│   ├── experiments/
│   │   └── mem_experiment_<hash>.json
│   └── style/
│       └── mem_style_<hash>.json
├── graph/
│   ├── nodes.jsonl
│   └── edges.jsonl
├── indexes/
│   ├── lexical.sqlite
│   └── semantic.sqlite
├── exports/
│   ├── architecture-decisions.md
│   ├── failure-cases.md
│   └── coding-style.md
└── snapshots/
    └── 2026-05-19/
```

### 11.2 Project-local `.deep-memory`

```text
.deep-memory/
├── project-profile.json
├── latest-harvest.json
├── latest-brief.json
├── latest-brief.md
├── suppressions.yaml
└── cache/
```

project-local에는 “이 프로젝트에서 최근 어떤 memory를 썼는지”만 둔다. cross-project store는 home-level에 둔다.

---

## 12. Project Identity 설계

Cross-project memory에서 중요한 것은 project identity다.

프로젝트 이름만으로는 부족하다. repo 이름이 바뀔 수 있고, fork될 수 있고, 비슷한 이름이 많을 수 있다.

`project-profile.json` 예시:

```json
{
  "project_id": "proj_8f42a1",
  "repo": {
    "remote_url_hash": "sha256:...",
    "root_path_hash": "sha256:...",
    "default_branch": "main"
  },
  "signature": {
    "languages": ["typescript", "bash"],
    "runtimes": ["node"],
    "topology": "plugin-marketplace",
    "test_frameworks": ["vitest", "pytest"],
    "package_managers": ["npm"],
    "agent_runtime": ["claude-code", "codex"]
  },
  "suite": {
    "installed_plugins": [
      "deep-work",
      "deep-wiki",
      "deep-evolve",
      "deep-review",
      "deep-docs",
      "deep-dashboard"
    ]
  },
  "privacy": {
    "scope": "local",
    "allow_export": false
  }
}
```

이렇게 해야 memory retrieval이 단순 keyword가 아니라 project similarity 기반으로 가능해진다.

---

## 13. Retrieval 방식

`deep-memory brief`는 단순 semantic search가 아니라 ranking pipeline이어야 한다.

추천 ranking:

```text
1. Hard filter
   - privacy scope
   - project allowlist
   - memory status != deprecated
   - review_after not too old, or stale penalty

2. Project similarity
   - language
   - topology
   - framework
   - plugin/runtime similarity

3. Task similarity
   - user task text
   - changed files
   - current phase
   - plugin command

4. Evidence quality
   - source artifact count
   - validated_by count
   - reused_successfully count
   - contradicted_by penalty

5. Applicability guard
   - applicability match
   - non_applicability mismatch

6. Diversity
   - avoid returning 5 near-duplicate failure cases
```

출력에는 항상 다음 정보가 포함되어야 한다.

```text
- memory
- 왜 관련 있는지
- 어디서 나온 것인지
- 적용하면 무엇을 해야 하는지
- 적용하면 안 되는 조건
```

이 정보를 넣지 않으면 agent가 memory를 맹신할 수 있다.

---

## 14. Privacy / Trust Boundary

Cross-project memory는 잘못 설계하면 민감 정보가 섞일 수 있다.

특히 회사 프로젝트, 개인 프로젝트, 오픈소스 프로젝트가 섞일 수 있으므로 기본 정책은 보수적으로 잡아야 한다.

### 14.1 기본 원칙

```text
1. local-first
2. opt-in project only
3. no secrets
4. no raw source code by default
5. evidence path는 저장하되 raw content는 최소화
6. organization export는 별도 승인 필요
7. memory는 항상 provenance 필수
8. memory는 자동 실행 근거가 아니라 판단 보조 자료
```

### 14.2 Redaction Rule

`deep-memory harvest`는 아래 정보를 제거하거나 저장 금지해야 한다.

```text
- API keys
- tokens
- private URLs
- 이메일
- 내부 도메인
- customer data
- DB connection strings
- path containing home/user names
- raw proprietary source code block
```

### 14.3 Privacy Scope

```yaml
privacy:
  default_scope: local
  scopes:
    local:
      share: false
    team:
      share: explicit
    org:
      share: explicit
```

초기 버전에서는 `local`만 지원해도 충분하다. team/org 공유는 이후 단계가 적합하다.

---

## 15. 구현 로드맵

### Phase 0 — 설계 고정

목표:

```text
deep-memory의 역할을 deep-wiki, deep-dashboard, deep-evolve와 분리해서 명확히 정의
```

산출물:

```text
claude-deep-memory repo 생성
README.md
AGENTS.md
CLAUDE.md
.codex-plugin/plugin.json
.claude-plugin/plugin.json
skills/deep-memory/SKILL.md
```

결정해야 할 것:

```text
- memory_root 기본 위치
- privacy 기본 정책
- memory card schema
- project profile schema
- harvest 대상 artifact
```

### Phase 1 — Harvest MVP

목표:

```text
현재 프로젝트의 deep-suite artifact를 읽어서 memory-event를 만든다.
```

지원 대상:

```text
.deep-work/session-receipt.json
.deep-review/recurring-findings.json
.deep-evolve/evolve-insights.json
.deep-docs/last-scan.json
.deep-dashboard/harnessability-report.json
<wiki_root>/.wiki-meta/index.json
```

명령:

```bash
/deep-memory init
/deep-memory harvest
/deep-memory audit
```

출력:

```text
.deep-memory/latest-harvest.json
~/.claude/deep-suite/memory/events/YYYY-MM.jsonl
```

성공 기준:

```text
- 모든 event는 envelope-wrapped
- source_artifacts.run_id가 있으면 반드시 연결
- schema validation 통과
- 민감 정보 redaction 테스트 통과
```

### Phase 2 — Memory Card Distillation

목표:

```text
raw event를 reusable memory card로 변환
```

지원 card:

```text
pattern
failure-case
architecture-decision
experiment-outcome
coding-style
```

명령:

```bash
/deep-memory distill
/deep-memory query "<question>"
```

성공 기준:

```text
- 모든 card는 evidence_summary를 가진다
- 모든 card는 applicability/non_applicability를 가진다
- 중복 card dedupe 동작
- status: candidate / validated / deprecated 지원
```

### Phase 3 — Brief Injection

목표:

```text
deep-work Phase 1 Research에 memory brief를 주입
```

명령:

```bash
/deep-memory brief "<task>"
```

출력:

```text
.deep-memory/latest-brief.json
.deep-memory/latest-brief.md
```

deep-work 변경:

```text
Research phase에서 latest-brief를 읽고
"Cross-project Memory" 섹션을 포함
```

성공 기준:

```text
- task당 top 5~10 memory만 주입
- relevance reason 포함
- 적용 금지 조건 포함
- memory가 없으면 graceful null
```

### Phase 4 — deep-review / deep-evolve 통합

목표:

```text
failure-case memory를 review에,
experiment-outcome memory를 evolve에 연결
```

deep-review:

```text
/deep-review 시작 시 관련 failure/style memory를 읽음
리뷰 결과에서 새로운 failure-case 후보를 생성
```

deep-evolve:

```text
init 시 experiment-outcome memory를 strategy seed 후보로 사용
완료 시 experiment-outcome card 생성
```

성공 기준:

```text
- review가 과거 failure를 기준으로 구체적 체크를 추가
- evolve가 유사 프로젝트의 성공 strategy를 가져옴
- 실패한 strategy도 avoid_when으로 저장
```

### Phase 5 — Reasoning Graph

목표:

```text
memory card 간 lineage와 causality를 graph로 구성
```

명령:

```bash
/deep-memory graph "<topic>"
```

출력:

```text
graph/nodes.jsonl
graph/edges.jsonl
exports/*.md
```

성공 기준:

```text
- architecture decision lineage 조회 가능
- failure → mitigation → validation 연결 가능
- experiment outcome → transferred_to 연결 가능
```

### Phase 6 — Dashboard Telemetry

목표:

```text
deep-dashboard가 memory health를 측정
```

추가 metric:

```text
suite.memory.cards_total
suite.memory.validated_ratio
suite.memory.stale_ratio
suite.memory.reuse_rate
suite.memory.false_positive_rate
suite.memory.graph_orphan_ratio
```

성공 기준:

```text
/deep-harness-dashboard --suite에서 memory 섹션 표시
memory debt 감지
stale memory 추천 액션 표시
```

---

## 16. 피해야 할 방향

### 16.1 모든 프로젝트 wiki를 하나로 합치기

위험하다. context가 섞이고 프로젝트별 특수성이 사라진다.

권장 방향:

```text
project wiki는 유지
global memory는 card/graph로만 추상화
```

### 16.2 원문 전체를 vector DB에 넣기

이건 단순 RAG로 회귀하는 것이다.

권장 방향:

```text
source artifact
→ distilled memory card
→ evidence-linked retrieval
```

### 16.3 자동 hook으로 모든 것을 저장하기

초기부터 SessionStart/Stop hook으로 자동 harvest를 켜면 privacy와 품질 문제가 생긴다.

권장 방향:

```text
초기: 명시 호출
중기: opt-in hook
후기: project allowlist 기반 자동 harvest
```

### 16.4 성공 사례만 저장하기

실패 사례가 더 가치 있다.

반드시 저장해야 하는 것:

```text
- 왜 실패했는가
- 어떤 조건에서 실패했는가
- 어떻게 해결했는가
- 다른 프로젝트에 적용하면 안 되는 조건은 무엇인가
```

### 16.5 confidence 없는 memory

모든 memory는 confidence와 status가 필요하다.

```text
candidate
validated
contradicted
deprecated
```

이 상태가 없으면 memory는 곧 오염된다.

---

## 17. 최종 추천 구조

최종적으로 deep-suite는 다음 구조로 진화하는 것이 좋다.

```text
deep-work
= 실행 프로토콜 / phase control / evidence-driven implementation

deep-review
= 독립 검증 / failure detection

deep-evolve
= autonomous experimentation / strategy evolution

deep-docs
= documentation freshness / instruction hygiene

deep-wiki
= project-local persistent knowledge

deep-dashboard
= suite telemetry / harness diagnostics

deep-memory
= cross-project semantic operational memory / reasoning graph
```

즉 deep-suite의 다음 단계는 다음 흐름이다.

```text
project-local harness
        ↓
cross-plugin artifact bus
        ↓
cross-project operational memory
        ↓
organization reasoning graph
```

---

## 18. 한 줄 제안

`deep-memory`를 7번째 플러그인으로 추가해서, 현재 M3 envelope와 suite-extensions data_flow 위에 **cross-project semantic operational memory layer**를 올리는 것이 가장 좋은 방향이다.

이렇게 하면 다음 목표가 자연스럽게 구현된다.

```text
프로젝트 간 패턴 학습
실패 사례 재사용
architecture decision lineage
experiment outcome memory
coding style evolution
organization-wide reasoning graph
```

그리고 이 방향은 현재 deep-suite가 이미 갖고 있는 다음 기반을 그대로 확장하는 구조라 일관성이 높다.

```text
M3 artifact envelope
run_id / parent_run_id chain
sidecar manifest
dashboard telemetry
Phase 5 recommendation loop
deep-wiki persistent knowledge
deep-evolve meta-archive
```

---

## 19. 참고한 주요 파일

- [`claude-deep-suite/README.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/README.md)
- [`claude-deep-suite/.claude-plugin/suite-extensions.json`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/.claude-plugin/suite-extensions.json)
- [`claude-deep-suite/schemas/artifact-envelope.schema.json`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/schemas/artifact-envelope.schema.json)
- [`claude-deep-suite/schemas/suite-extensions.schema.json`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/schemas/suite-extensions.schema.json)
- [`claude-deep-suite/.claude-plugin/marketplace.json`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/.claude-plugin/marketplace.json)
- [`claude-deep-suite/.agents/plugins/marketplace.json`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/.agents/plugins/marketplace.json)
- [`claude-deep-suite/guides/integrated-workflow-guide.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/guides/integrated-workflow-guide.md)
- [`claude-deep-suite/docs/envelope-migration.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/docs/envelope-migration.md)
- [`claude-deep-suite/guides/context-management.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/guides/context-management.md)
- [`claude-deep-wiki/README.md`](https://github.com/Sungmin-Cho/claude-deep-wiki/blob/main/README.md)
- [`claude-deep-dashboard/README.md`](https://github.com/Sungmin-Cho/claude-deep-dashboard/blob/main/README.md)
- [`claude-deep-evolve/README.md`](https://github.com/Sungmin-Cho/claude-deep-evolve/blob/main/README.md)
