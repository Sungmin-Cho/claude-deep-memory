---
name: deep-memory-brief
description: "Retrieve the top-N memory cards for a task, writing `.deep-memory/latest-brief.json` + `.md` atomically. Privacy-scoped: `local` cards stay in their own project, `global` cards surface everywhere. Triggers on `/deep-memory-brief <task>`, \"recall memories\", \"memory brief\", \"메모리 회상\", \"deep-memory brief\". Args: task (required), `--top=N`."
user-invocable: true
---

# deep-memory-brief — Top-N retrieval brief for a task

Generate a structured brief of the most relevant memory cards for the user's stated task, drawing from the project-local and global deep-memory store.

호출: `/deep-memory-brief <task> [--top=N]` (Claude Code 슬래시) 또는 `Skill({ skill: "deep-memory:deep-memory-brief", args: "<task> [--top=N]" })` (Codex / 타 에이전트 / SDK). 두 경로 모두 같은 토큰 문자열을 받아 아래 retrieval pipeline 으로 들어갑니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| `<task>` (required) | 자연어 task 설명. 따옴표로 감싸면 멀티-토큰 task 허용 |
| `--top=N` | `config.yaml#retrieve.top_n` 오버라이드 (기본 8) |

## Prerequisites

- `/deep-memory-init` 는 project-local 카드를 위해 권장. profile 이 missing/invalid 여도 abort 하지 않고 global-only retrieval 로 계속합니다.
- 한 번 이상의 `/deep-memory-harvest` 가 있어야 의미 있는 brief 가 나옵니다. zero-card 상태에서도 빈 brief 가 정상 출력됩니다.
- `better-sqlite3` 권장 (`optionalDependencies`). 부재 시 아래 Degraded paths 로 graceful degradation.

## Steps

전체 절차는 `${CLAUDE_PLUGIN_ROOT}/scripts/brief.js` 가 단일 진입점으로 수행합니다.

1. **profile 로드** — `.deep-memory/project-profile.json` 읽기. missing/invalid 이면 warning 을 남기고 global-only retrieval 로 계속.
2. **retrieve pipeline 실행** — `${CLAUDE_PLUGIN_ROOT}/scripts/retrieve.js` 의 `runRetrieve({ task, projectProfile, memoryRoot })`:
   - **Stage 0** — native FTS5 사용 시 `fts-index.search(task, { projectId, topN: N×3 })` (BM25 overfetch + SQL privacy scope filter). Native adapter 를 사용할 수 없으면 bounded privacy-scoped card scan 이 global/current-project 물리 scope 만 탐색.
   - **Stage 1** — hard filter: `status !== 'deprecated'`
   - **Stage 2** — `bm25MinMax` 정규화 (작은 BM25 = 좋은 매치 → invert)
   - **Stage 3** — full card payload load (per `memory_id` → `cards/<type>/{global|<project_id>}/*.json`)
   - **Stage 4** — `project_sim` (Jaccard on languages/runtimes). 프로필 없으면 `w_project_sim=0`.
   - **Stage 5** — `evidence_quality` (sigmoid clamp via `score.js`)
   - **Stage 6** — `applicability guard`: task tokens ∩ `non_applicability.value` Jaccard ≥ 0.5 → drop
   - **Stage 7** — `diversity`: 같은 `dedupe_key` 클러스터 1개만, per `memory_type` 최대 `diversity_per_type` (기본 2)
   - **Stage 8** — `review_after` 경과를 stale penalty `p` 로 변환하고 `score = w_project_sim·s + w_task_sim·t + w_evidence·e − w_stale_penalty·p`, sort desc, take `top_n`. Stale 카드는 hard drop 하지 않고 순위만 낮춥니다.
3. **brief render** — `${CLAUDE_PLUGIN_ROOT}/scripts/lib/brief-format.js` 의 `renderJson(task, cards)` + `renderMarkdown(...)`:
   - `avoid_when ← non_applicability[].value` (fallback `"(none specified)"`)
   - `recommended_action ← card.payload.recommended_action` (fallback `"(none — refer to evidence)"`)
   - `why_relevant ← '(retrieved by lexical match)'` (fallback)
4. **atomic write** — `.deep-memory/latest-brief.json` + `.deep-memory/latest-brief.md` via `writeJsonAtomic` + `writeTextAtomic`
5. **stdout summary** — N개의 brief 요약 출력

## Privacy invariant

- `privacy_level === 'local'` 카드는 `project_id` 가 일치하는 retrieve 에서만 보입니다.
- `privacy_level === 'global'` 카드는 모든 project 에서 보입니다.
- Native FTS5 경로는 `fts-index.search` 의 SQL `WHERE` 절에서 privacy scope 를 제한합니다.
- Bounded card scan 경로는 global 및 validated current-project 의 physically contained card 디렉토리만 열어 같은 privacy scope 를 유지하며, 다른 local project scope 는 탐색하지 않습니다.

## Degraded paths (graceful)

- **profile 부재/무효** — global-only retrieval + warning. local card scope 는 열지 않습니다.
- **memory_root 부재 (zero harvest)** — empty brief (`memories: []`), MD 에 "no memories yet — run /deep-memory-harvest" 안내.
- **better-sqlite3 부재 / 로드 실패 / v2 index 부재** — bounded privacy-scoped card scan 으로 graceful degradation. global-only/project scope 규칙과 총 filesystem budget 을 유지하며 warning 을 노출합니다.

## Outputs

- `.deep-memory/latest-brief.json` (project-local) — full structured brief
- `.deep-memory/latest-brief.md` (project-local) — human-readable summary
- stdout: 1-line summary `Brief: N memories retrieved for task "<task>"`

## See also

`deep-memory-init` (선행) · `deep-memory-harvest` (index 채움, 선행 필수) · `deep-memory-audit` (schema · stale · lock · promotion 점검)
