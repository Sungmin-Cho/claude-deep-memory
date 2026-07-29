---
name: deep-memory-audit
description: "Audit the deep-memory store — card schema (Ajv strict), stale-memory transitions, stale locks, dedupe collisions, source renames, profile freshness. Triggers on `/deep-memory-audit`, \"audit memory\", \"deep-memory audit\", \"메모리 감사\", \"메모리 점검\". `--unlock` breaks a stale lock; `--promote <memory_id>` moves a trusted current-project card to global."
user-invocable: true
---

# deep-memory-audit — Health check + maintenance

Run end-to-end health checks against the deep-memory store and optionally apply maintenance actions.

호출: `/deep-memory-audit [flags]` (Claude Code 슬래시) 또는 `Skill({ skill: "deep-memory:deep-memory-audit", args: "[flags]" })` (Codex / 타 에이전트 / SDK). 두 경로 모두 같은 토큰 문자열을 받아 아래 절차를 그대로 실행합니다.

## Sub-commands

| 인자 | 동작 | audit.js 함수 |
|---|---|---|
| (없음) | 6개 sub-check 실행 + `.deep-memory/latest-audit.json` atomic write | `run()` |
| `--unlock` | stale lock detect + 5분 이상 된 lock 디렉토리 제거 | `unlock()` |
| `--promote <memory_id> [--project <project_id>]` | trusted profile 의 validated current project scope 카드만 global 로 atomic 승격. `--project` 는 trusted profile 값과 일치해야 함. | `promoteCard(id, { projectId })` |

## Steps (default — no flags)

`run()` 은 read-only sub-check 5개를 **lock 획득 전에** 먼저 돌립니다. stale lock 때문에 `acquire` 가 실패하더라도 그 사실이 리포트에 남아야 하기 때문입니다.

1. **memory_root 확인** — `~/.deep-memory/` 존재 + preflight 통과. 없으면 `/deep-memory-init` 안내.
2. **Schema validation** (`validateAllCards`) — `cards/<type>/<scope>/*.json` 전체를 Ajv strict 로 검증 (`memory-card.schema.json`). 위반 카드는 `schema_violations[]` 로 보고.
3. **Stale-lock detect** (`detectStaleLocks`) — `<memory_root>/.lock` metadata 가 5분 이상이면 보고. `--unlock` 이 있으면 `lock.breakLock` 호출.
4. **Dedupe collision** (`detectDedupeCollisions`) — 같은 `dedupe_key` 인데 `applicability` source_id 가 모순되는 카드 쌍 보고.
5. **Source-rename detect** (`detectSourceRenames`) — 각 카드의 `envelope.provenance.source_artifacts[].path` 가 디스크에 있는지 + `content_hash` 일치 검증. mismatch 는 `unresolved_source` 로 보고.
6. **Profile freshness** (`detectStaleProfile`) — `.deep-memory/project-profile.json` 의 `generated_at` 이 `config.yaml#audit.profile_max_age_days` (기본 30) 보다 오래면 warning + `/deep-memory-init` 재실행 제안.
7. **Stale-memory state transitions** (`applyAutoTransitions`) — 여기서만 lock 을 잡고, 각 카드에 `state-machine.evaluateTransitions` 적용 (`review_after` 경과 + `status=validated` → `deprecated` + `status_history` append, `writeJsonAtomic` in-place). lock 을 못 잡으면 transition 을 건너뛰고 `skipped_due_to_lock` 을 리포트에 기록합니다 — audit 는 그래도 완주합니다.
8. **결과 보고** — `.deep-memory/latest-audit.json` atomic write + 콘솔 1-line 요약.

## `--promote <memory_id>`

`promoteCard()` 는 global lock (`<memory_root>/.lock`) 안에서 실행됩니다 — harvest 가 persist window 에서 같은 lock 을 잡으므로 promote 와 harvest 는 race 하지 않고 직렬화됩니다. validated current project scope 없이는 `PROJECT_SCOPE_REQUIRED` 로 거부합니다.

lock 안에서: `privacy_level` 을 `global` 로 바꾸고 `last_seen_at` 을 갱신, `status_history` 에 `{from, to, at, by: 'manual:promote'}` 1건 append (status 자체는 변하지 않으며 history 는 최근 10건으로 제한), 카드를 global scope 로 옮기고 local 사본을 unlink, FTS5 row 를 `project_id: ''` 로 upsert. 이 경로는 lexical FTS5 만 갱신하며 vector index 는 건드리지 않습니다.

## Outputs

- `.deep-memory/latest-audit.json` (atomic write) — `summary.total_cards` / `summary.issues` / `summary.auto_fixed` + `schema` · `transitions` · `stale_locks` · `dedupe` · `source_renames` · `profile` 전체 결과
- 콘솔: 1-line 요약

## Privacy invariant

- `--promote` 만이 `privacy_level: local → global` 을 바꿉니다.
- promote 후 FTS5 row 의 `project_id` 가 `''` 가 되어 모든 project 에서 visible.

## Error handling

- `LOCK_HELD` — promote 가 harvest 와 충돌. lock 해제 후 재시도.
- `STALE_LOCK` — 5분 이상 lock. audit 가 표시하고 `--unlock` 이 명시적으로 break.
- `ALREADY_GLOBAL` / `NOT_FOUND` — promote 대상이 이미 global 이거나 존재하지 않음.
- Ajv schema violation — `latest-audit.json` 의 `schema_violations[]` 에 모이고 audit 는 graceful 종료.

## Index recovery boundary

- 읽기/쓰기 대상은 `~/.deep-memory/indexes/v2/lexical.sqlite` 뿐입니다.
- 1.0.1 `~/.deep-memory/indexes/lexical.sqlite` 는 sealed legacy artifact 로 probe/삭제/이전하지 않습니다.
- 복구가 필요하면 cards 를 source of truth 로 삼아 v2 인덱스만 manual non-migrating recovery 합니다.

## See also

`deep-memory-init` (선행) · `deep-memory-harvest` (index 채움) · `deep-memory-brief` (retrieval)
