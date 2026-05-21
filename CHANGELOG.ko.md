# Changelog

deep-memory의 모든 주요 변경 사항이 여기에 기록됩니다. [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따릅니다.

## [0.1.2] - 2026-05-21

### Fixed

- **Node v26+ 첫 사용 차단 — FTS5 graceful degradation** — v0.1.0
  round-5 ITEM-4 가 `better-sqlite3` 로드 실패 시 harvest 를 hard-throw 시켰음.
  Node v26+ 환경 (prebuilt binary 아직 미배포 + 마켓플레이스 플러그인 캐시
  immutable 로 즉석 재빌드 불가) 에는 잘못된 자세였음. v0.1.2 에서 graceful
  degradation 으로 되돌림:
    - harvest 가 cards/events 를 disk 에 정상 기록; FTS5 upsert 만 skip.
    - 명시적 warning 을 `cards.warnings` (CLI summary) 로 노출, 같은 메시지가
      `.deep-memory/latest-harvest.json` 의 `warnings[]` 에도 기록.
    - `/deep-memory-brief` 는 hard-throw 대신 `{ memories: [], warnings: [...] }`
      형태로 동일한 actionable 메시지를 반환.
    - `scripts/harvest.js` 가 `FTS_DEGRADED_WARNING` + `isFtsAvailable()` 을
      skill harness / 테스트 용으로 노출.
    - sql.js WASM fallback 이 근본 해결책이며 v0.2.0 으로 계속 이연.
  신규 테스트: `tests/harvest-fts-silent-disable.test.js` (harvest 측 graceful
  동작) + `tests/retrieve-fts-degraded.test.js` (retrieve 측).
- **Step A mapper shape 정렬 (silent 0-card harvest 차단)** — v0.1.0의 5개
  Step A mapper 중 4개가 ideal-shape payload 를 기대하도록 작성되어, sibling
  plugin 의 실제 emit shape 와 mismatch. v0.1.0 은 실제 sibling artifact 을
  소비해도 silent 하게 0 card 를 생성했음. 4개 mapper 를 sibling 실제 shape 으로 재정렬:
    - `mapRecurringFindings` — sibling 실제 shape `findings[].{category, severity, occurrences, example_files, description, source_reports}` 소비 (기존 ideal-shape 의 `title/evidence/tags/first_seen` 은 sibling 에 존재하지 않음). `description → claim`, `example_files → evidence_summary`, `[category, severity] → tags`.
    - `mapEvolveInsights` — `payload.insights_for_deep_work[]` + `payload.insights_for_deep_review[]` 두 array union (sibling 에는 `payload.insights[]` 가 없음). item shape `{pattern, evidence, source_archive_ids, suggestion}`. `suggestion → claim`, `pattern → title`, tag로 대상 식별.
    - `mapWorkReceipt` — `payload.slices` 는 aggregate object `{total, completed, spike}` (array 아님). **Option A** 채택: session-receipt 당 1 card (요약). slice-level memory 는 후속 source-kind 로 이연.
    - `mapDocsScan` — `payload.documents[].issues[]` (nested). flatten: 1 issue = 1 card. severity 매핑 confidence (high=0.7, medium=0.5, low=0.3).
    - `mapWikiIndex` — 변경 없음 (sibling shape 와 이미 일치).
- spec §7.1 mapper rule 표를 sibling 실제 shape 기준으로 재작성 (`docs/superpowers/specs/2026-05-20-deep-memory-design.md`).
- v0.1.0 ideal-shape 로컬 fixture 를 sibling-real shape 으로 교체 (`tests/fixtures/sample-{recurring-findings, evolve-insights, session-receipt-{success,failure}, last-scan}.json`).

### Added

- `tests/sibling-shape-smoke.test.js` — invariant smoke test. 각 sibling repo 의
  실제 fixture (`../../deep-{review,evolve,work,docs}/tests/fixtures/`) 를 읽어
  mapper 당 ≥1 card 보장. 미래에 sibling shape 이 또 바뀌면 silent regression 대신
  즉시 적색 신호. sibling repo 미체크아웃 시 graceful skip.

### Breaking

- **spec §7.1 mapper 기대값 재작성.** 옛 ideal-shape mapper 규칙에 맞춰
  deep-memory artifact 을 손으로 만들었던 소비자는 재생성 필요. on-disk card
  format 은 그대로, envelope schema 도 그대로. **sibling source artifact → memory draft**
  의 매핑 규칙만 변경됨.

## [0.1.0] - 2026-05-20

### Added (MVP — 설계 명세의 Phase 0-3)

- 두 개의 매니페스트(Claude Code + Codex) — 스킬 기반 진입 표면
- 4개의 사용자 호출 스킬(`deep-memory-init`, `deep-memory-harvest`, `deep-memory-brief`, `deep-memory-audit`) + 1개의 레퍼런스 스킬(`memory-schema`)
- 하이브리드 distill 파이프라인: 규칙 기반 Step A(5가지 메모리 타입) + LLM 서브에이전트 Step B, 실패 시 candidate 상태로 우아한 폴백
- 크로스 런타임 LLM 어댑터 브리지(claude-agent / codex-bash / gemini-sdk / stdin-fallback)
- M3 envelope으로 래핑된 events + cards + briefs
- 6단계 랭킹(hard filter / project sim / task sim / evidence quality / applicability guard / diversity)을 적용한 sqlite FTS5 어휘 검색
- 3패스 규칙 기반 리댁션(Step A 입력 / Step B 입력 / envelope 래핑)
- 카드별 `privacy_level: local | global`과 명시적 `--promote` 게이트
- 원자적 쓰기(temp+fsync+rename+readback 검증) + `{pid, host, created_at}` 메타데이터를 포함한 mkdir 기반 잠금 + 오래된 잠금 감지(>5분) + `--unlock` 복구
- 멱등 이벤트 키(sha256(path+content_hash+run_id))를 사용하는 프로젝트 lease
- `runtime-contract/` 어댑터별 픽스처를 포함한 12개 테스트 스위트
- 스위트 통합: `deep-suite/.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json` + `suite-extensions.json` 항목

### 알려진 제한 사항

- **다중 프로젝트 memory_id 충돌 (C-R1, v0.2.0에서 해결 예정)** — 동일한 `~/.deep-memory` 저장소를 공유하는 두 프로젝트가 동일한 `dedupe_key`를 생성하는 아티팩트를 수집할 경우, 두 프로젝트는 동일한 `memory_id`를 갖게 됩니다. FTS 어휘 색인(FTS5)은 `memory_id` 단독으로 키가 지정되어 있어, 두 번째 프로젝트의 harvest가 첫 번째 프로젝트의 색인 행을 덮어씁니다. 디스크의 카드 파일은 보존됩니다(`cards/<type>/<project_id>/` 아래 범위별로 분리됨). 그러나 v0.2.0에서 ID 체계를 재설계하기 전까지 `/deep-memory-brief`가 존재하지 않거나 누락된 결과를 반환할 수 있습니다. v0.1.0은 **단일 프로젝트 환경에서 안전합니다(single-project-safe)**. 해결 방법: 프로젝트별로 `DEEP_MEMORY_ROOT` 환경 변수를 별도로 설정하세요.
