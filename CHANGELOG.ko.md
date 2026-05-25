# Changelog

deep-memory의 모든 주요 변경 사항이 여기에 기록됩니다. [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따릅니다.

## [0.3.2] - 2026-05-25

### Fixed (수정)

- **capture 토글 플래그가 구현되지 않았던 문제.** v0.3.0 스펙(§3.6)은
  자동 capture 옵트인 토글을 설계했지만 `init.js`에는 빠져 있었음:
  `defaultConfigYaml()`에 `capture:` 블록이 없고, CLI 파서가 capture 플래그를
  무시했으며, 기존 `config.yaml`은 덮어쓰지 않으므로 — capture를 켜는 유일한
  방법이 YAML 수동 편집이었음. CHANGELOG/README도 존재하지 않는 `--capture`
  플래그를 언급해 문서/코드 불일치가 있었음.

### Added (추가)

- **`--enable-capture` / `--disable-capture`** 플래그 (`/deep-memory-init`,
  상호 배타 → 동시 지정 시 exit 1). 스펙 §3.6 line 644 명명을 따른 불리언
  플래그. `config.yaml#capture.enabled` 기록 — 단일 `config.yaml` 전역 설정으로
  모든 워크스페이스에 적용.
- **`scripts/lib/capture-toggle.js`** — `setCaptureEnabled(root, target, opts)`:
  타깃 텍스트 편집(`common.mjs` 훅 리더 정규식과 바이트 호환), 멱등
  (실제 상태 전이 시에만 `capture-toggle` audit-log `{from, to, method}` 1건
  기록, no-op은 무기록).
- **`scripts/lib/default-config.js`** — `defaultConfigYaml()`을 독립 모듈로
  추출(단일 진실원천; init↔capture-toggle require 순환 방지) +
  `capture: {enabled: false, eager_distill: false}` 블록 추가 (capture 기본
  OFF, 프라이버시 불변식).
- **`writeTextAtomic`** (`scripts/lib/atomic-write.js`) — `config.yaml` 같은
  원본 텍스트(비-JSON) atomic write.

### Tests (테스트)

- `tests/capture-toggle.test.js` (10 케이스): default-config 블록, enable /
  disable / 멱등 no-op 전이, 전이당 audit 1건, legacy-config append 경로,
  init `run({capture})` 연동, CLI 상호 배타, 그리고 writer 출력이
  `post-tool-use` 훅 리더에 enabled로 인식되는지 검증하는 hook-contract
  회귀 테스트. 전체 스위트: 357 pass / 0 fail.

## [0.3.1] - 2026-05-22

### Fixed (수정)

- **`.mcp.json` env-block interpolation 충돌** (Sonnet R1 W-1 finding;
  설치 시점에 노출). Claude Code `.mcp.json`은 `${VAR}` env 보간만 지원,
  bash 스타일 `${VAR:-default}`는 미지원. 리터럴 문자열
  `${DEEP_MEMORY_ROOT:-${HOME}/.deep-memory}`이 spawned MCP 서버에
  그대로 전달되어 stdio 핸드셰이크 전 크래시. `/reload-plugins`가
  `Failed to reconnect to deep-memory: -32000` 보고. Fix: `.mcp.json` +
  `.claude-plugin/plugin.json#mcpServers` 양쪽에서 redundant env 블록
  제거. `scripts/mcp-server.mjs`가 이미 `process.env.DEEP_MEMORY_ROOT ||
  path.join(os.homedir(), '.deep-memory')` fallback 보유.

- **Version bump 0.3.0 → 0.3.1** (릴리즈 플러밍). Plugin manager는
  "already at latest version" 체크를 `.claude-plugin/plugin.json`의
  version string으로 함 (git SHA 아님). env-block fix가 main에 land한
  후 `/plugin update` 시도한 v0.3.0 사용자는 0.3.0 cache directory가
  존재하므로 "already at latest" 보고 받음 — cached `.mcp.json`이 여전히
  깨진 env 블록 가짐에도 불구하고. 0.3.1 patch가 fresh fetch 강제.

## [0.3.0] - 2026-05-22

agentmemory-style 대규모 개편: 크로스 런타임 hook capture + 3-계층 메모리 모델
(Events → Cards → Briefs) + slash-only mutation gate를 갖춘 MCP 서버.
주요 버전 (0.2.x 건너뜀 — sql.js fallback은 별도 트랙으로 제공).

구현 과정: 스펙 4-라운드 deep-review-loop (24 → 11 finding) + 플랜 2-라운드
deep-review-loop (graduate CONCERN) → 6-phase TDD 실행 → 구현 2-라운드
4-way deep-review-loop (7 🔴 → 1 🔴 → 0 🔴, ship-ready).

### Added (추가)

- **6개 Tier-1 hook script** (`scripts/hooks/*.mjs`) — Claude Code + Codex의
  SessionStart / UserPromptSubmit / PostToolUse / PostToolUseFailure /
  PreCompact / SessionEnd 이벤트 캡처 (Codex는 4-hook subset, spec §3.5).
  모든 hook이 stdin 읽기 **이전**에 `config.capture.enabled` 게이트 적용
  (PR1-D / R4-D privacy invariant).
- **새 `memory-hook-event` artifact_kind** (schemas/memory-hook-event.schema.json):
  11-필드 envelope + 모든 레벨에서 strict `additionalProperties: false`.
  v0.1.x `memory-event` 스키마와 공존 (수정 없음, byte-stable).
- **3-계층 메모리 모델** — agentmemory 패턴 적용 (Events → Cards → Briefs).
- **5개 결정론적 detector** (`scripts/lib/distill-hook-session.js`): pattern,
  failure-case, decision, coding-style, session-summary fallback.
- **Vector index** (`scripts/lib/vector-index.js`) COMPOSITE
  (memory_id, project_id) PRIMARY KEY로 C-R1 vector-side 닫음.
- **@xenova/transformers lazy loader** widened catch (R4-I + PR2-E):
  어떤 load 에러든 → FTS5-only fallback.
- **RRF fusion** composite 키 (PR2-F) + Hybrid retrieval orchestrator
  + session diversification (γ.6) + graceful matrix (γ.7).
- **MCP 서버** (`scripts/mcp-server.mjs`): 10 tools + 5 resources + 2 prompts.
  Host가 `.mcp.json` 통해 자동 spawn. Mutation tools는 Gate 2/3으로 slash-only.
- **3개의 새 slash skill**: deep-memory-forget, deep-memory-promote,
  deep-memory-export. 각각 audit-log 이중 emission (R4-K).
- **Audit-log envelope writer**: 10 kind + oneOf payload validation (R3-J / R4-E).

### Changed (변경)

- **4-pass 통합 redaction**: 3개의 promoted 룰 (generic homedir, env-var,
  stack-trace homedir)이 공유 파이프라인에 통합 (PR1-E / W2 / W3).
- **Byte-offset cursor** (R3-A): `<YYYY-MM>.jsonl:<byte_offset>` 포맷,
  forward-only monotonic + cross-file rollover.

### Performance (성능)

- G-α p95 = 72ms (목표 ≤400ms, 82% headroom)
- G-β p95 = 66ms (목표 ≤500ms, 87% headroom)
- Lock-split invariant: distill-pipeline.js는 `./lock` require하지 않음.

### v0.3.1로 연기된 항목

- γ.1 composite key로 FTS5 전체 widening
- ε.3-ε.4 init.js multi-marker + migration cursor init
- δ.16 audit skill 수정 + δ.19 Gate 1 cross-project read scope flag
- hooks-stats.json per-hook 카운터 텔레메트리
- §3.2.1 fire-and-forget invariants 전체 구현

전체 연기 목록은 `docs/handoff-v0.3.0-postrelease.md` 참조.

### Migration (마이그레이션)

- v0.1.x→v0.3.0: 저장소 레이아웃에 `events/`, `audit-log/`,
  `.last-distill-cursor/`, `indexes/vector.sqlite`, `.embed-model-version` 추가.
- v0.1.x reader 호환: legacy adapter (R4-H)로 flat-event 합성 후 계속 읽힘.
- Capture default: 비대화형 init에서 **OFF** (privacy-by-default).
  사용자 prompt 또는 `/deep-memory-init --capture`로 명시적 opt-in.

## [0.1.3] - 2026-05-21

Round 1 deep-review-loop 대응 (리뷰 리포트 `2026-05-21-151916-review.md`,
verdict=CONCERN, 4 🟡 + 3 ℹ️). 7개 항목 중 5개 fast-follow patch.

### Fixed

- **Privacy invariant — degraded-mode warning redaction** (Codex adversarial 🟡 #2).
  `ftsLoadError` 가 `cards.warnings` 와 `latest-harvest.json` 에 raw 로 연결되어,
  native loader 에러에 절대 homedir 경로가 들어있으면 disk 로 누수됨.
  `scripts/harvest.js` + `scripts/retrieve.js` 양쪽에서 `redactString` 경유로 수정.
  회귀 테스트 (`harvest-fts-silent-disable.test.js` +
  `retrieve-fts-degraded.test.js`) 가 `os.homedir()` 포함 simulated 에러를 주입해
  결과 warning 이 `~/` 마커를 포함하는지 검증.
- **`better-sqlite3` 를 `optionalDependencies` 로 이동** (Codex 🟡 #1).
  v0.1.2 까지는 `dependencies` 에 있어서 native build 실패 시 `npm install`
  자체가 abort — v0.1.2 의 graceful runtime catch 가 실행될 기회조차 없음.
  이제 native build 실패해도 npm install 성공 + `harvest.js`/`retrieve.js`
  runtime catch 가 명시적 warning 노출. marketplace-cache 시나리오 (prebuilt
  내장) 무영향. v0.2.0 sql.js WASM fallback 은 별도 트랙으로 계속 추적.
- **`tests/sibling-shape-smoke.test.js` env-gated hard-fail** (Opus 🟡 #3).
  `DEEP_MEMORY_FULL_SUITE=1` 설정 시 (예: 전체 sibling suite 를 clone 하는
  CI runner), sibling fixture 부재가 silent skip 대신 loud fail. 기본 동작
  (env var 없음) 은 그대로 — partial-checkout 개발 환경 영향 없음.
- **`cards.warnings` 회귀 커버리지** (Opus 🟡 #4).
  `harvest-fts-silent-disable.test.js` 신규 테스트 — fts-load 실패 시뮬레이션
  + `harvestArtifact()` 호출 + `cards.warnings` 가 non-empty array 이고
  `FTS_DEGRADED_WARNING` 포함하는지 검증 (그리고 redaction 통과). v0.1.2 가
  실제 degraded-mode 반환값을 검증하지 못하던 gap 해소.
- **SKILL.md 문서 drift** (Opus ℹ️ #1). `deep-memory-brief/SKILL.md` +
  `deep-memory-harvest/SKILL.md` 의 degraded-paths 섹션이 pre-v0.1.2 hard-fail
  설명을 유지하고 있어 v0.1.2/v0.1.3 graceful 동작에 맞게 갱신.

### Deferred to user

- v0.1.2 CHANGELOG 의 "Breaking" 라벨 (Opus ℹ️ #2) — editorial; 현재 framing 이
  conservative 하지만 strictly 틀린 것은 아니므로 사용자 재량으로 위임.

### Not addressed (rejected with rationale)

- Quietly-quarantined edge cases (Opus ℹ️ #3) — 지적된 edge (`session_id` +
  `task_description` 둘다 없음 등) 는 F1 quarantine 경로로 올바르게 funnel 되고
  있음. 각각에 대한 테스트 추가는 신규 failure mode 를 surface 하지 않으므로
  coverage matrix 만 부풀림. 거부.

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
