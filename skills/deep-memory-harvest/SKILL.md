---
name: deep-memory-harvest
description: "Scan the current project for deep-suite artifacts (recurring-findings, evolve-insights, session-receipts, docs-scan, wiki-index), apply rule-based extraction (Step A — 5 memory types) + sub-agent refinement (Step B via llm-bridge), apply 3-pass redaction, and persist events + cards under ~/.deep-memory/ with atomic write + project lease + idempotent event keys. Triggers on `/deep-memory-harvest`, \"harvest deep-suite\", \"메모리 수집\", \"메모리 하베스트\", \"deep-memory harvest\". Optional args: `<artifact-path>` (specific source instead of full scan) and `--limit=N` (cap card creation count)."
user-invocable: true
---

# deep-memory-harvest — Scan + distill + persist

Harvest deep-suite sibling artifacts, distill them through the two-step pipeline (rule-based Step A + sub-agent Step B), and persist the resulting memory cards under `~/.deep-memory/`.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — `/deep-memory-harvest [<artifact-path>] [--limit=N]`.
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-memory:deep-memory-harvest", args: "[<artifact-path>] [--limit=N]" })`.

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, Step 3 의 source resolution 이 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | `config.yaml` 의 `sources[]` 전체에 대해 glob 스캔 |
| `<artifact-path>` | 특정 artifact 만 인제스트 (glob 도 허용; 절대 또는 project-root 상대) |
| `--limit=N` | card 생성 상한 (오버 시 다음 harvest 까지 deferred) |

## Prerequisites

- `/deep-memory-init` 가 선행되어 있어야 함 — `.deep-memory/project-profile.json` 부재 시 init 안내 후 abort.
- 형제 deep-suite 플러그인이 적어도 하나 설치/실행되어 artifact 가 생성되어 있어야 의미 있는 결과가 나옴 (없으면 zero-card harvest + 정상 종료).

## Steps

1. **profile 로드** — `.deep-memory/project-profile.json` 읽기. 없으면 `/deep-memory-init` 실행 안내 후 종료.
2. **project lease 획득** — `~/.deep-memory/.leases/<project_id>.lease` 에 `{pid, host, started_at}` 작성. 다른 활성 세션이 점유 중이면 abort (stale-break: 30분).
3. **sources 발견** — `~/.deep-memory/config.yaml` 의 `sources[]` 항목을 project-root 상대로 glob 평가. 명시적 `<artifact-path>` arg 가 있으면 그 set 으로 override.
4. **각 artifact 처리** (per-source loop):
   - producer / artifact_kind / schema_version 헤더 확인 → mis-match 면 skip + warning.
   - **Pass 1 redaction** (raw JSON 입력) → **Step A mapper** (`STEP_A_MAPPERS[sourceKind]`) → event-draft (5 memory_type 중 하나).
   - **Pass 2 redaction** (Step A 결과) → **llm-bridge.refine()** (`Step B`) → response schema 검증 (`memory-card-distill-output.schema.json`).
   - **Pass 3 redaction** (Step B 결과) → envelope wrap (`payload.deep_memory_provenance`) → mkdir lock acquire → dedupe (`dedupe_key`) check → card atomic write → events JSONL idempotent append (`event_key`) → FTS5 upsert (같은 lock window 안 commit) → lock release.
5. **lease 해제** — `~/.deep-memory/.leases/<project_id>.lease` 삭제 (finally guard).
6. **결과 보고** — `.deep-memory/latest-harvest.json` (project-local) 에 `{sources_scanned, events_created, cards_created, skipped, warnings, generated_at}` atomic write. 콘솔에도 동일 summary 출력.

전체 절차는 `scripts/harvest.js` 가 단일 진입점으로 수행합니다. v0.1.0 CLI는 아티팩트 1개를 직접 지정하는 방식입니다:

```
node scripts/harvest.js <artifact-path> --kind <sourceKind> [--project <projectId>]
```

`sourceKind`: `review-recurring | evolve-insights | work-receipt | docs-scan | wiki-index`

config.yaml 기반 전체 glob 스캔은 v0.1.x에서 제공 예정입니다.

## Invariants (spec §7.3 reference)

- **F1 claim never-empty** — Step A → B 어느 단계든 `claim` 공란인 draft 는 quarantine (`~/.deep-memory/.quarantine/`) 으로 분리, card 가 되지 않음.
- **3-pass redaction** — 동일한 redact rule 을 Pass 1 / 2 / 3 에서 모두 적용 (multi-stage 누락 방지).
- **lease + lock** — project lease 는 같은 project 안 동시 harvest 충돌 방지, `~/.deep-memory/.lock` 은 cards/events/index 의 atomic 일관성 보장.
- **idempotent event** — `event_key = sha256(source.path | content_hash | run_id)`. 동일 key 의 event line 이 이미 있으면 skip (concurrent harvest 도 single line 보장).
- **FTS5 upsert in lock window** — card atomic write 직후 같은 lock 안에서 index commit. release 전 commit 실패 시 카드도 롤백되어 cards · events · index 불일치 차단.

## Outputs

- `~/.deep-memory/cards/<memory_type>/<project_id>/<memory_id>.json`
- `~/.deep-memory/events/YYYY-MM.jsonl` (append-only)
- `~/.deep-memory/indexes/lexical.sqlite` (FTS5 upsert)
- `.deep-memory/latest-harvest.json` (project-local summary)

## Privacy invariant

- 모든 신규 card 의 `payload.privacy_level` 은 `local` 로 시작.
- 3-pass redaction 의 합산 변환 byte 수가 `config.yaml#audit.high_redaction_chars` 임계를 넘으면 audit 가 high-redaction 경고 표시.
- `global` 승격은 `/deep-memory-audit --promote <id>` 만이 수행 — harvest 자체는 절대 promote 하지 않음.

## Error handling

- `Another session already harvesting project <id>` — lease 충돌. 다른 셸 종료 또는 30분 후 자동 stale-break.
- `Unknown sourceKind` — config.yaml 의 `sources[*].kind` 가 builtin mapper 와 불일치. config 확인 안내.
- LLM Step B 실패 (`llm-bridge.on_failure: candidate`) — Step A 결과만으로 candidate card 생성 (Step B 결여 → confidence 낮음).
- FTS5 upsert 실패 → lock 안에서 카드 write 롤백 (release 전 throw, 다음 harvest 가 재시도).

## See also

- `deep-memory-init` — 선행 init skill
- `deep-memory-brief` — top-N retrieval skill (post-harvest)
- `deep-memory-audit` — schema · stale · lock · promotion 점검 skill
- `memory-schema` — schema invariants 참조 skill (sibling)
