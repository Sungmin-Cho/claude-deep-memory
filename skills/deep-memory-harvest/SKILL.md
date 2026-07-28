---
name: deep-memory-harvest
description: "Distil deep-suite artifacts into memory cards — Step A rules, Step B sub-agent, 3-pass redaction — and persist under `~/.deep-memory/` with atomic write, project lease, and idempotent event keys. Triggers on `/deep-memory-harvest`, \"harvest deep-suite\", \"메모리 수집\", \"메모리 하베스트\", \"deep-memory harvest\". Args: `<artifact-path>`, `--limit=N`."
user-invocable: true
---

# deep-memory-harvest — Scan + distill + persist

Harvest deep-suite sibling artifacts, distill them through the two-step pipeline, and persist the resulting memory cards under `~/.deep-memory/`.

호출: `/deep-memory-harvest [<artifact-path>] [--limit=N]` (Claude Code 슬래시) 또는 `Skill({ skill: "deep-memory:deep-memory-harvest", args: "[<artifact-path>] [--limit=N]" })` (Codex / 타 에이전트 / SDK). 두 경로 모두 같은 토큰 문자열을 받아 아래 절차를 그대로 실행합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | `config.yaml` 의 `sources[]` 전체에 대해 glob 스캔 |
| `<artifact-path>` | 특정 artifact 만 인제스트 (glob 허용; 절대 또는 project-root 상대) |
| `--limit=N` | card 생성 상한 (초과분은 다음 harvest 로 deferred) |

## Prerequisites

- `/deep-memory-init` 선행 — `.deep-memory/project-profile.json` 부재 시 init 안내 후 abort.
- 형제 deep-suite 플러그인이 artifact 를 하나라도 남겼어야 의미 있는 결과가 나옵니다 (없으면 zero-card harvest 후 정상 종료).

## 역할 분담

`${CLAUDE_PLUGIN_ROOT}/scripts/harvest.js` 의 CLI 는 **artifact 하나**를 받습니다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/harvest.js" <artifact-path> --kind <sourceKind> [--project <projectId>] [--skip-distill-step-b]
```

여러 소스를 도는 스캔은 이 스킬이 담당합니다 — `config.yaml#sources[]` 를 project-root 상대로 glob 평가해 대상을 모으고, artifact 마다 위 CLI 를 한 번씩 호출합니다. lease · lock · redaction · persist 는 호출마다 harvest.js 안에서 완결됩니다.

`sourceKind` 와 그 producer / artifact_kind / memory_type / 기본 경로의 정본은 `${CLAUDE_PLUGIN_ROOT}/scripts/lib/default-config.js` 의 `sources[]` 이고, 런타임 값은 사용자의 `~/.deep-memory/config.yaml` 입니다. 등록된 kind 집합은 `harvest.js` 의 `STEP_A_MAPPERS` 키와 정확히 일치해야 하며 테스트가 이를 강제합니다.

## Steps

1. **profile 로드** — `.deep-memory/project-profile.json`. 없으면 `/deep-memory-init` 안내 후 종료.
2. **project lease 획득** — `~/.deep-memory/.leases/<project_id>.lease` 에 `{pid, host, started_at}`. 다른 활성 세션이 점유 중이면 abort (stale-break: 30분).
3. **sources 발견** — 위 §역할 분담 대로 glob 평가. 명시적 `<artifact-path>` arg 가 있으면 그 set 으로 override.
4. **각 artifact 처리** (per-source loop):
   - producer / artifact_kind / schema_version 헤더 확인 → mis-match 면 skip + warning.
   - **Pass 1 redaction** (raw JSON 입력) → **Step A mapper** (`STEP_A_MAPPERS[sourceKind]`) → event-draft (5 memory_type 중 하나).
   - **Pass 2 redaction** (Step A 결과) → **llm-bridge.refine()** (`Step B`) → response schema 검증 (`memory-card-distill-output.schema.json`).
   - **Pass 3 redaction** (Step B 결과) → envelope wrap (`payload.deep_memory_provenance`) → mkdir lock acquire → dedupe (`dedupe_key`) check → card atomic write → events JSONL idempotent append (`event_key`) → FTS5 upsert (같은 lock window 안 commit) → lock release.
5. **lease 해제** — lease 파일 삭제 (finally guard).
6. **결과 보고** — `.deep-memory/latest-harvest.json` 에 `{sources_scanned, events_created, cards_created, skipped, warnings, generated_at}` atomic write + 동일 summary 콘솔 출력.

### Step B host dispatch

- The Claude Code host mediator invokes the named `memory-distiller` agent and passes only the redacted request fields.
- The Codex host mediator spawns a generic subagent. Its first action is to read `${PLUGIN_ROOT}/agents/memory-distiller.md`; it must preserve the agent's `Read, Glob, Grep only; no write` restriction and return JSON only.
- The mediator implements `deep-memory-host-distill-v1` through an executable process spec. Missing mediation is an explicit candidate fallback, never a hidden no-op.
- Gemini and other hosts retain their configured SDK or stdin adapter and state when they fall back.
- Every result passes contract verification and `llm-bridge` Ajv validation. Invalid or timeout output remains a candidate fallback.

`--skip-distill-step-b` is an explicit offline opt-out. Without it, the CLI attempts Step B and records any typed fallback warning in `latest-harvest.json`.

## Invariants

- **F1 claim never-empty** — Step A → B 어느 단계든 `claim` 이 공란인 draft 는 quarantine (`~/.deep-memory/.quarantine/`) 으로 분리되며 card 가 되지 않습니다.
- **3-pass redaction** — 동일한 redact rule 을 Pass 1 / 2 / 3 에서 모두 적용 (multi-stage 누락 방지).
- **lease + lock** — project lease 는 같은 project 안 동시 harvest 충돌을 막고, `~/.deep-memory/.lock` 은 cards/events/index 의 atomic 일관성을 보장합니다.
- **idempotent event** — `event_key = sha256(source.path | content_hash | run_id)`. 같은 key 의 event line 이 이미 있으면 skip (concurrent harvest 도 single line 보장).
- **FTS5 upsert in lock window** — card atomic write 직후 같은 lock 안에서 index commit. `better-sqlite3` 로드 실패 시 graceful degradation (cards/events 는 정상 write, FTS5 upsert 만 skip + warning). 런타임 upsert 실패는 lock release 전에 throw 되며 다음 harvest 가 재시도합니다.

## Outputs

- `~/.deep-memory/cards/<memory_type>/<project_id>/<memory_id>.json`
- `~/.deep-memory/events/YYYY-MM.jsonl` (append-only)
- `~/.deep-memory/indexes/v2/lexical.sqlite` (FTS5 upsert)
- `.deep-memory/latest-harvest.json` (project-local summary)

1.0.1 `~/.deep-memory/indexes/lexical.sqlite` 는 sealed legacy artifact 로 열거나 삭제하지 않습니다. 복구가 필요하면 v2 인덱스에 대한 manual non-migrating recovery 만 수행합니다.

## Privacy invariant

- 모든 신규 card 의 `payload.privacy_level` 은 `local` 로 시작합니다.
- 3-pass redaction 의 합산 변환 byte 수가 `config.yaml#audit.high_redaction_chars` 임계를 넘으면 audit 가 high-redaction 경고를 표시합니다.
- `global` 승격은 `/deep-memory-audit --promote <id>` (또는 `/deep-memory-promote`) 만이 수행합니다 — harvest 는 절대 promote 하지 않습니다.

## Error handling

- `Another session already harvesting project <id>` — lease 충돌. 다른 셸 종료 또는 30분 후 자동 stale-break.
- `Unknown sourceKind` — `config.yaml#sources[*].kind` 가 `STEP_A_MAPPERS` 와 불일치. config 확인 안내.
- Step B 실패 (`llm-bridge.on_failure: candidate`) — Step A 결과만으로 candidate card 생성 (confidence 낮음).
- `better-sqlite3` unavailable → cards/events 는 정상 write, FTS5 upsert 만 skip. `cards.warnings` (non-enumerable) 와 `latest-harvest.json` 의 `warnings[]` 양쪽에 redacted warning 노출.
- FTS5 런타임 upsert 실패 → lock 안에서 throw. lock + lease 는 finally 가 정리하고 cards 는 이미 disk 에 commit 된 상태. v2 인덱스만 manual non-migrating recovery 하며 sealed legacy index 는 건드리지 않습니다.

## See also

`deep-memory-init` (선행) · `deep-memory-brief` (post-harvest retrieval) · `deep-memory-audit` (schema · stale · lock · promotion 점검)
