---
name: deep-memory-brief
description: "Generate a task-specific deep-memory brief — top-N memory cards retrieved via FTS5 BM25 + project similarity + evidence quality + applicability guard + diversity stage (spec §8 6-stage ranking). Outputs `.deep-memory/latest-brief.json` + `.deep-memory/latest-brief.md` atomically. Privacy scope filter (local cards visible only to same project_id; global cards to all). Triggers on `/deep-memory-brief <task>`, \"recall memories\", \"memory brief\", \"메모리 회상\", \"deep-memory brief\". Args: task description (required), optional `--top=N` to override config.yaml#retrieve.top_n."
user-invocable: true
---

# deep-memory-brief — Top-N retrieval brief for a task

Generate a structured brief of the most relevant memory cards for the user's stated task, drawing from the project-local and global deep-memory store.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — `/deep-memory-brief <task> [--top=N]`
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-memory:deep-memory-brief", args: "<task> [--top=N]" })`

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, Step 2 의 retrieval pipeline 이 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| `<task>` (required) | 자연어 task 설명. 따옴표로 감싸면 멀티-토큰 task 허용 |
| `--top=N` | `config.yaml#retrieve.top_n` 오버라이드 (기본 8) |

## Prerequisites

- `/deep-memory-init` 가 선행되어야 함 — `.deep-memory/project-profile.json` 부재 시 init 안내 후 abort.
- 한 번 이상의 `/deep-memory-harvest` 가 실행되어 cards/events/index 가 채워져 있어야 의미 있는 brief 생성. zero-card 상태에서도 빈 brief 가 정상 출력.
- `better-sqlite3` 권장 — `optionalDependencies` 로 설치. 부재 시 graceful degradation (아래 Degraded paths 참조).

## Steps

1. **profile 로드** — `.deep-memory/project-profile.json` 읽기. 없으면 `/deep-memory-init` 안내 후 abort.
2. **retrieve pipeline 실행** — `scripts/retrieve.js` 의 `runRetrieve({ task, projectProfile, memoryRoot })`:
   - **Stage 0** — `fts-index.search(task, { projectId, topN: N×3 })` (FTS5 BM25 overfetch + privacy scope filter)
   - **Stage 1** — hard filter: `status !== 'deprecated'`, `review_after` 미경과
   - **Stage 2** — `bm25MinMax` 정규화 (P13 — 작은 BM25 = 좋은 매치 → invert)
   - **Stage 3** — full card payload load (per `memory_id` → `cards/<type>/{global|<project_id>}/*.json`)
   - **Stage 4** — `project_sim` (Jaccard on languages/runtimes). 프로필 없으면 `w_project_sim=0`.
   - **Stage 5** — `evidence_quality` (sigmoid clamp via `score.js`)
   - **Stage 6** — `applicability guard`: task tokens ∩ `non_applicability.value` Jaccard ≥ 0.5 → drop
   - **Stage 7** — `diversity`: 같은 `dedupe_key` 클러스터 1개만, per `memory_type` 최대 `diversity_per_type` (기본 2)
   - **Stage 8** — `score = w_project_sim·s + w_task_sim·t + w_evidence·e − w_stale_penalty·p`, sort desc, take `top_n`
3. **brief render** — `scripts/lib/brief-format.js` 의 `renderJson(task, cards)` + `renderMarkdown(...)`:
   - `avoid_when ← non_applicability[].value` (mapping, F2 fallback to "(none specified)")
   - `recommended_action ← card.payload.recommended_action` (fallback to "(none — refer to evidence)")
   - `why_relevant ← '(retrieved by lexical match)'` (fallback)
4. **atomic write** — `.deep-memory/latest-brief.json` + `.deep-memory/latest-brief.md` via `writeJsonAtomic` + `writeFileSync`
5. **stdout summary** — 사용자에게 N개의 brief 요약 출력

전체 절차는 `scripts/brief.js` 가 단일 진입점으로 수행합니다.

## Privacy invariant

- `privacy_level === 'local'` 카드는 `project_id` 가 일치하는 retrieve 에서만 보임.
- `privacy_level === 'global'` 카드는 모든 project 에서 보임.
- privacy filter 는 SQL 레벨 (`fts-index.search` 의 `WHERE` 절) 에서 적용 — 애플리케이션 레이어 우회 불가.

## Degraded paths (graceful)

- **profile 부재** — abort with `/deep-memory-init` 안내.
- **memory_root 부재 (zero harvest)** — empty brief 출력 (`memories: []`), MD 에 "no memories yet — run /deep-memory-harvest" 안내.
- **better-sqlite3 부재 / 로드 실패** — v0.1.2+ graceful degradation. brief 는 `{ memories: [], warnings: [<FTS5 unavailable 메시지>] }` 반환 (hard fail 아님). 사용자에게는 Node 22 LTS 권장 또는 v0.2.0 sql.js fallback 대기 안내 (README.md > Troubleshooting). v0.1.3+ 에서 warning 메시지의 native loader 경로는 `redactString` 으로 redaction 처리됨 (homedir 누수 없음).

## Outputs

- `.deep-memory/latest-brief.json` (project-local) — full structured brief
- `.deep-memory/latest-brief.md` (project-local) — human-readable summary
- stdout: 1-line summary `Brief: N memories retrieved for task "<task>"`

## See also

- `deep-memory-init` — 선행 init skill
- `deep-memory-harvest` — index 채움 skill (선행 필수)
- `deep-memory-audit` — schema · stale · lock · promotion 점검 skill
- `memory-schema` — schema invariants 참조 skill
