---
name: deep-memory-audit
description: "Audit the deep-memory store — schema validation (Ajv strict on every card), stale-memory state-machine transitions, stale-lock detection (`--unlock` to break), dedupe-collision report (spec §6.4), source-rename detect via content_hash, project-profile freshness check, and atomic `--promote <id>` to move a local card → global (lock-aware vs concurrent harvest). Triggers on `/deep-memory-audit`, \"audit memory\", \"deep-memory audit\", \"메모리 감사\", \"메모리 점검\". Optional flags: `--unlock` (break stale locks), `--promote <memory_id> [--project <project_id>]` (local → global; `--project` disambiguates when same memory_id exists in multiple scopes)."
user-invocable: true
---

# deep-memory-audit — Health check + maintenance

Run end-to-end health checks against the deep-memory store and (optionally) apply maintenance actions.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — `/deep-memory-audit [flags]`
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-memory:deep-memory-audit", args: "[flags]" })`

## Sub-commands

| 인자 | 동작 | audit.js 함수 |
|---|---|---|
| (없음) | 7개 sub-check 전체 실행 + `.deep-memory/latest-audit.json` atomic write | `run()` |
| `--unlock` | stale lock detect + 5분 이상 된 lock 디렉토리 제거 | `unlock()` |
| `--promote <memory_id> [--project <project_id>]` | local 카드를 global 로 atomic 승격 (lock 보호). 같은 `memory_id` 가 2개 이상 scope 에 존재하면 `--project <project_id>` 로 disambiguate 필요 — 미지정 시 `AMBIGUOUS` 에러 반환. | `promoteCard(id, { projectId })` |

## Steps (default — no flags)

1. **memory_root 확인** — `~/.deep-memory/` 존재 + preflight 통과. 없으면 `/deep-memory-init` 안내.
2. **Schema validation** (`validateAllCards`) — `cards/<type>/<scope>/*.json` 전체를 Ajv strict 로 검증 (`memory-card.schema.json`). 위반 카드는 `latest-audit.json` 에 `schema_violations[]` 로 보고.
3. **Stale-memory state transitions** (`applyAutoTransitions`) — 각 카드에 `state-machine.evaluateTransitions` 적용:
   - `review_after` 경과 + `status=validated` → `deprecated` + `status_history` append
   - `writeJsonAtomic` 으로 in-place 업데이트
4. **Stale-lock detect** (`detectStaleLocks`) — `<memory_root>/.lock` 디렉토리 metadata 가 5분 이상 → 보고. `--unlock` 플래그가 있으면 `lock.breakLock` 호출.
5. **Dedupe collision** (`detectDedupeCollisions`) — 같은 `dedupe_key` 인데 `applicability` source_id 가 모순되는 카드 쌍을 보고 (spec §6.4 conflict policy).
6. **Source-rename detect** (`detectSourceRenames`) — 각 카드 의 `envelope.provenance.source_artifacts[].path` 가 디스크에서 발견 + `content_hash` 매치 검증. mismatch 시 `unresolved_source` 보고.
7. **Profile freshness** (`detectStaleProfile`) — `.deep-memory/project-profile.json` 의 `generated_at` 이 `config.yaml#audit.profile_max_age_days` (기본 30) 보다 오래 → warning + `/deep-memory-init` 재실행 제안.
8. **결과 보고** — `.deep-memory/latest-audit.json` atomic write + 콘솔 1-line 요약.

## `--promote <memory_id>` 절차

`P8 fix — lock 보호`. 같은 카드의 `dedupe_key` 충돌 검사로 harvest 가 양쪽 디렉토리를 union scan 할 수 있어야 하므로 promote 도 같은 global lock 안에서 수행:

1. global lock acquire (`<memory_root>/.lock` via `lib/lock.acquire`)
2. card `privacy_level: local → global`
3. atomic move `cards/<type>/<project_id>/<id>.json` → `cards/<type>/global/<id>.json`
4. `status_history` append (transition reason `'promote'`)
5. FTS5 upsert with `project_id = ''` (global scope)
6. lock release

harvest 가 lock 점유 중이면 `LOCK_HELD` 에러 — 사용자에게 다시 시도 안내.

## Outputs

- `.deep-memory/latest-audit.json` (atomic write) — full structured audit result
- 콘솔: 1-line summary `Audit: <N> issues found (<M> auto-fixed)`

## Privacy invariant

- `--promote` 만이 `privacy_level: local → global` 변경 가능.
- `--promote` 는 global lock 안에서 atomic 이므로 harvest 와 race 안 함.
- Promote 후 FTS5 row 의 `project_id` 가 `''` 로 갱신되어 모든 project 에서 visible.

## Error handling

- `LOCK_HELD` — promote 가 harvest 와 충돌. 사용자에게 lock 해제 후 재시도 안내.
- `STALE_LOCK` (`lib/lock`) — 5분 이상 lock → audit 가 표시. `--unlock` 으로 명시 break.
- Ajv schema violation — `latest-audit.json` 의 `schema_violations[]` 에 모이고, audit 는 graceful 종료.

## v0.1.x scope

Index rebuild is planned for v0.1.x — until then, delete `~/.deep-memory/indexes/lexical.sqlite` and re-harvest to rebuild.

## See also

- `deep-memory-init` — 선행 init skill
- `deep-memory-harvest` — index 채움 skill
- `deep-memory-brief` — retrieval skill
- `memory-schema` — schema invariants 참조 skill
