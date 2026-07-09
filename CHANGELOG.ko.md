# Changelog

deep-memory의 모든 주요 변경 사항이 여기에 기록됩니다. [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 및 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) 형식을 따릅니다.

## [1.0.1] - 2026-07-09

### Fixed (수정)

- **설치 시점 `npm ci` 없이도 MCP startup 가능.** Claude Code와 Codex MCP
  manifest가 이제 bundled `dist/mcp-server.cjs` entrypoint를 실행합니다. 따라서
  marketplace/cache 설치물이 `node_modules` 없이 배치되어도 MCP stdio handshake와
  read-only tool surface 노출이 가능합니다.
- **MCP startup path의 dependency 축소.** Retrieval, distill, audit-log helper는
  관련 tool 호출 시점에만 lazy-load합니다. 서버는 `better-sqlite3` 같은 optional/native
  dependency가 없어도 먼저 시작하고 tool 목록을 반환할 수 있습니다.

### Tests (테스트)

- no-`node_modules` MCP smoke test를 추가했습니다. runtime에 필요한 plugin artifact
  파일만 복사한 뒤 `initialize` + `tools/list`가 10개 tool을 반환하는지 검증합니다.

## [1.0.0] - 2026-07-09

### Fixed (수정)

- **Codex hook manifest 로딩.** Codex plugin manifest가 Claude hook object를
  inline으로 넣는 대신 `./hooks/hooks.json`을 참조하도록 변경했습니다. 이로써 Codex
  session startup 중 hook 설정이 무시되는 경고를 방지합니다.
- **Codex hook parity.** 외부 Codex hook manifest에 `PostToolUseFailure`와
  `SessionEnd`를 포함한 전체 Tier-1 capture hook set을 등록했습니다.
- **release metadata drift.** MCP server metadata와 hook event envelope가 package
  version을 읽도록 하여 runtime `producer_version`이 plugin/package release version과
  동기화됩니다.

### Tests (테스트)

- Codex hooks가 외부 hooks manifest를 사용하고 예상 hook entry가 모두 존재하는지
  검증하는 manifest-drift 회귀 테스트를 추가했습니다.

## [0.4.0] - 2026-07-07

### Fixed (수정)

- **MCP 도구가 가짜 성공을 보고하던 문제.** 여러 `deep-memory` MCP 도구가 내부 store
  조회가 아무것도 못 찾거나 card payload를 resolve하지 못했을 때도 성공 형태를
  반환했습니다. 이제 fail-closed로 동작합니다 — card payload를 찾지 못한 fused row는
  빈 "성공" 대신 정직한 오류를 노출하며, recall/조회는 scope-strict입니다(global-privacy
  row는 global scope에서만 resolve; deprecated / 비적용 card는 hybrid 경로에서 필터링).
- **무손실 distill 커서.** 지연된 distill 커서를 `(file, offset)` 쌍으로 유지하여 월
  경계(rollover)를 넘어도 draft를 유실하거나 재emit하지 않습니다; 커서는 emit된 모든
  draft가 durable하게 반영된 뒤에만 전진합니다.
- **세션 hook 무파괴.** capture hook이 부작용으로 live 세션 상태를 변경/폐기하지
  않습니다.
- **harvest envelope 가드.** envelope-guard 경고를 redact·bound하고, harvest wrapper가
  emit 전에 `schema_version`을 검증하며, native-loader 오류는 MCP 경고에 도달하기 전에
  redact됩니다.

## [0.3.2] - 2026-05-25

### Added (추가)

- `/deep-memory-init`의 `--enable-capture` / `--disable-capture` 플래그(상호 배타).
  `config.yaml#capture.enabled`를 기록하며, 이 토글은 단일 `config.yaml`의 전역
  설정으로 모든 워크스페이스에 적용됩니다.
- 기본 설정에 `capture: {enabled: false, eager_distill: false}` 블록 추가
  (프라이버시 불변식에 따라 capture 기본 OFF).
- 실제 capture 토글이 일어날 때마다 `capture-toggle` audit-log 1건 기록; no-op은
  아무것도 기록하지 않음.

### Fixed (수정)

- **capture 토글 플래그가 구현되지 않았던 문제.** v0.3.0 설계는 자동 capture 옵트인
  토글을 명세했지만 `init`에는 빠져 있었음: 기본 설정에 `capture:` 블록이 없고, CLI
  파서가 capture 플래그를 무시했으며, 기존 `config.yaml`은 덮어쓰지 않으므로 —
  capture를 켜는 유일한 방법이 YAML 수동 편집이었음. README도 존재하지 않는
  `--capture` 플래그를 언급했음.

## [0.3.1] - 2026-05-22

### Fixed (수정)

- **`.mcp.json` env-block interpolation 충돌**(설치 시점에 노출). Claude Code
  `.mcp.json`은 `${VAR}` env 보간만 지원하고 bash 스타일 `${VAR:-default}`는
  미지원. 리터럴 문자열 `${DEEP_MEMORY_ROOT:-${HOME}/.deep-memory}`가 spawned MCP
  서버에 그대로 전달되어 stdio 핸드셰이크 전에 크래시(`/reload-plugins`가
  `Failed to reconnect to deep-memory: -32000` 보고). Fix: redundant env 블록 제거.
  MCP 서버는 이미 올바른 `DEEP_MEMORY_ROOT` / `~/.deep-memory` fallback 보유.
- **Version bump 0.3.0 → 0.3.1**(릴리스 플러밍). Plugin manager는 "already at latest
  version" 체크를 git SHA가 아닌 version string으로 하므로, env-block fix가 land한
  뒤 `/plugin update`를 시도한 v0.3.0 사용자는 깨진 `.mcp.json`을 가진 cache
  디렉터리에 대해 "already at latest"를 받았음. 0.3.1 patch가 fresh fetch를 강제.

## [0.3.0] - 2026-05-22

agentmemory-style 대규모 개편: 크로스 런타임 hook capture + 3계층 메모리 모델
(Events → Cards → Briefs) + slash 전용 mutation 게이트를 가진 MCP 서버. 주요
버전입니다(0.2.x 건너뜀 — sql.js fallback은 별도로 제공).

### Added (추가)

- **6개 Tier-1 hook script** — Claude Code와 Codex의 SessionStart /
  UserPromptSubmit / PostToolUse / PostToolUseFailure / PreCompact / SessionEnd
  이벤트 캡처(Codex는 4-hook subset). 모든 hook이 stdin 읽기 이전에
  `config.capture.enabled` 게이트를 적용(프라이버시 불변식).
- **새 `memory-hook-event` artifact kind** — 11필드 envelope + 모든 레벨에서 strict
  `additionalProperties: false`. v0.1.x `memory-event` 스키마와 공존(수정 없음).
- **3계층 메모리 모델**(agentmemory 패턴):
  - Events — 월별 `events/YYYY-MM.jsonl`, append-only.
  - Cards — vector index에서 composite (memory_id, project_id) 키.
  - Briefs — 하이브리드 검색(FTS5 + vector) + session diversification.
- **5개 결정론적 detector**(pattern, failure-case, decision, coding-style,
  session-summary fallback) — zero-LLM Step A 매퍼.
- **Vector index** — composite (memory_id, project_id) primary key로 C-R1 충돌을
  vector 측에서 닫음; brute-force cosine + graceful fallback.
- **@xenova/transformers lazy loader** — widened catch: 어떤 load 에러든 FTS5-only
  검색으로 graceful degrade, model-version mismatch 체크 포함.
- **RRF fusion** + **하이브리드 검색 오케스트레이터** — FTS5 + vector 결합 +
  session diversification + graceful-matrix probe.
- **MCP 서버** — 10 tools + 5 resources + 2 prompts. Host가 `.mcp.json`을 통해 자동
  spawn(수동 설정 불필요). Mutation tools는 slash 전용으로 강제.
- **3개의 새 slash skill** — mutation 경로: deep-memory-forget, deep-memory-promote,
  deep-memory-export. 각각 audit-log 이중 기록(consent + kind-specific).
- **Audit-log envelope writer** — 10 kind + oneOf payload validation.

### Changed (변경)

- **4-pass 통합 redaction**: 3개의 promoted 룰(generic homedir, env-var, stack-trace
  homedir)이 공유 redaction 파이프라인에 통합.
- **Byte-offset cursor**가 ISO-timestamp cursor를 대체. 포맷
  `<YYYY-MM>.jsonl:<byte_offset>`, forward-only monotonic + cross-file rollover.

### Performance (성능)

- 단일 PostToolUse 지연: p95 = 72ms(목표 ≤ 400ms).
- 동시 distill 시: p95 = 66ms(목표 ≤ 500ms).
- Lock-split 불변식: distill 파이프라인은 `./lock`을 잡지 않음 — LLM·embedding
  작업은 임계 구역 밖에서 실행.

### Migration (마이그레이션)

- v0.1.x → v0.3.0: 저장소 레이아웃에 `events/`, `audit-log/`,
  `.last-distill-cursor/`, `indexes/vector.sqlite`, `.embed-model-version` 추가.
- v0.1.x reader 호환: legacy flat-event 레코드는 schema 호환 envelope를 합성하는
  legacy adapter로 계속 읽힘.
- Capture 기본값: 비대화형 init에서 OFF. 사용자가 명시적으로 옵트인해야 함.

## [0.1.3] - 2026-05-21

### Fixed (수정)

- **degraded-mode 경고 redaction.** native-loader 에러 문자열이 `cards.warnings`와
  `latest-harvest.json`에 raw로 연결되어, 절대 homedir 경로가 들어있으면 disk로
  누수됨. 이제 harvest와 retrieve 양쪽에서 redaction 파이프라인을 거쳐 homedir를
  `~/`로 치환.
- **`better-sqlite3`를 `optionalDependencies`로 이동.** 이전에는 hard dependency라
  native build 실패 시 `npm install` 자체가 abort — graceful runtime catch가 실행될
  기회조차 없었음. 이제 native binding 실패해도 `npm install` 성공 + harvest·retrieve가
  명시적 degraded-mode 경고 노출.(prebuilt가 내장된 marketplace 캐시는 무영향.)
- **`sibling-shape-smoke` 테스트가 `DEEP_MEMORY_FULL_SUITE=1`에서 loud fail.** 전체
  sibling suite를 clone하는 CI runner에서 sibling fixture 부재가 silent skip 대신
  실패. 기본 동작(env var 없음)은 그대로라 partial-checkout 개발 환경 무영향.

## [0.1.2] - 2026-05-21

### Fixed (수정)

- **Node v26+ 첫 사용 차단 — FTS5 graceful degradation.** v0.1.0은 `better-sqlite3`
  로드 실패 시 harvest를 hard-throw 시켰는데, prebuilt binary가 아직 미배포이고
  마켓플레이스 플러그인 캐시가 immutable(즉석 재빌드 불가)인 Node v26+ 환경에는
  잘못된 자세였음. v0.1.2에서 graceful degradation으로 되돌림:
    - harvest가 cards/events를 disk에 정상 기록; FTS5 upsert만 skip.
    - 명시적 경고를 `cards.warnings`로 노출하고 `.deep-memory/latest-harvest.json`에도
      미러링.
    - `/deep-memory-brief`는 hard-throw 대신 `{ memories: [], warnings: [...] }`로
      동일한 actionable 메시지 반환.
    - (sql.js WASM fallback이 근본 해결책이며 이후 릴리스로 이연.)
- **Step A mapper shape 정렬(silent 0-card harvest 차단).** 5개 Step A 매퍼 중 4개가
  sibling 플러그인의 실제 emit과 맞지 않는 ideal-shape payload를 기대해, 실제 sibling
  artifact를 소비해도 0개 카드를 생성했음. 4개를 sibling 실제 shape으로 재정렬:
    - `mapRecurringFindings` — `findings[].{category, severity, occurrences,
      example_files, description, source_reports}` 소비.
    - `mapEvolveInsights` — `insights_for_deep_work[]` + `insights_for_deep_review[]`
      union 소비.
    - `mapWorkReceipt` — `slices`는 array가 아닌 aggregate object; session-receipt당
      1 card 생성(slice-level memory는 후속 source kind로 이연).
    - `mapDocsScan` — `documents[].issues[]`를 flatten해 issue당 1 card,
      severity 매핑 confidence.
    - `mapWikiIndex` — 변경 없음(이미 일치).

### Added (추가)

- `sibling-shape-smoke` 테스트 — 각 sibling repo의 실제 fixture를 읽어 매퍼당 ≥ 1
  card를 보장하여, 미래에 sibling shape이 또 바뀌면 silent regression 대신 즉시
  실패. sibling repo 미체크아웃 시 graceful skip.

### Breaking

- **매퍼 기대값 재작성.** 옛 ideal-shape 매퍼 규칙에 맞춰 deep-memory artifact를
  손으로 만들었던 소비자는 재생성 필요. on-disk card 포맷 변경 없음, envelope schema
  변경 없음 — sibling source artifact → memory draft의 매핑 규칙만 변경됨.

## [0.1.0] - 2026-05-20

### Added (MVP)

- 두 개의 매니페스트(Claude Code + Codex) — 스킬 기반 진입 표면.
- 4개의 사용자 호출 스킬(`deep-memory-init`, `deep-memory-harvest`,
  `deep-memory-brief`, `deep-memory-audit`) + 1개의 레퍼런스 스킬(`memory-schema`).
- 하이브리드 distill 파이프라인: 규칙 기반 Step A(5가지 메모리 타입) + LLM
  서브에이전트 Step B, 실패 시 candidate 상태로 우아한 폴백.
- 크로스 런타임 LLM 어댑터 브리지(claude-agent / codex-bash / gemini-sdk /
  stdin-fallback).
- M3 envelope으로 래핑된 events + cards + briefs.
- 6단계 랭킹(hard filter / project 유사도 / task 유사도 / evidence quality /
  applicability guard / diversity)을 적용한 sqlite FTS5 어휘 검색.
- 3패스 규칙 기반 리댁션(Step A 입력 / Step B 입력 / envelope 래핑).
- 카드별 `privacy_level: local | global`과 명시적 `--promote` 게이트.
- 원자적 쓰기(temp + fsync + rename + readback 검증) + `{pid, host, created_at}`
  메타데이터를 포함한 mkdir 기반 잠금, 오래된 잠금 감지(> 5분), `--unlock` 복구.
- 멱등 이벤트 키를 사용하는 프로젝트 lease.

### 알려진 제한 사항

- **다중 프로젝트 memory_id 충돌(C-R1).** 동일한 `~/.deep-memory` 저장소를 공유하는
  두 프로젝트가 동일한 `dedupe_key`를 생성하면 같은 `memory_id`를 갖게 됩니다. FTS5
  색인은 `memory_id` 단독으로 키가 지정되어 두 번째 프로젝트의 harvest가 첫 번째
  프로젝트의 색인 행을 덮어씁니다. 디스크의 카드 파일은 `project_id`별로 분리되어
  보존되지만, `/deep-memory-brief`가 존재하지 않거나 누락된 결과를 반환할 수
  있습니다. v0.1.0은 **단일 프로젝트 환경에서 안전합니다**. 해결 방법: 프로젝트별로
  `DEEP_MEMORY_ROOT`를 별도 설정하세요.
