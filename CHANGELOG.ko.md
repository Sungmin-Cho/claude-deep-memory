# Changelog

deep-memory의 모든 주요 변경 사항이 여기에 기록됩니다. [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따릅니다.

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
