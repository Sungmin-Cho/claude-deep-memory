# deep-memory

> [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)를 위한 크로스 프로젝트 시맨틱 운영 메모리.

deep-suite 형제 플러그인이 생성한 산출물을 수집하여, 재사용 가능한 메모리 카드(하이브리드: 규칙 기반 + LLM 서브에이전트)로 증류하고, 이후 작업이 회상할 수 있도록 작업별 메모리 브리프를 제공합니다.

## 상태

**v0.1.0 MVP** — 스켈레톤 + harvest + distill + brief + audit. 244 테스트 통과. Phase 4-6(writer 통합 / reasoning graph / dashboard 텔레메트리)은 [`docs/handoff-phase-4-6.md`](docs/handoff-phase-4-6.md)에서 추적됩니다.

## 설치

`claude-deep-suite` 마켓플레이스를 통해 설치:

```bash
# Claude Code
/plugin install deep-memory@claude-deep-suite

# Codex
codex plugin install deep-memory
```

또는 GitHub URL을 가리키는 `--source url`을 사용하여 이 저장소에서 직접 설치합니다.

## 빠른 시작

```bash
# 1. 메모리 루트 초기화 (기본값 ~/.deep-memory/; DEEP_MEMORY_ROOT 환경변수로 재정의 가능)
/deep-memory-init

# 2. 현재 프로젝트의 형제 플러그인 산출물을 수집
/deep-memory-harvest

# 3. 다가오는 작업에 대한 메모리 브리프 조회
/deep-memory-brief "implement Codex-compatible plugin manifest"

# 4. 주기적 감사 (오래된 메모리, 스키마 드리프트, 잠금 복구)
/deep-memory-audit
```

## 3계층 모델

1. **Events** — `~/.deep-memory/events/YYYY-MM.jsonl` 하위의 원시 수집 결과(append-only JSONL)
2. **Cards** — `~/.deep-memory/cards/<type>/{global,project_id}/` 하위의 증류된 M3 envelope 래핑 시맨틱 메모리
3. **Briefs** — 현재 프로젝트의 `.deep-memory/latest-brief.{json,md}`에 기록되는 top-N 검색 결과

## 스킬

| 스킬 | 목적 |
|---|---|
| `deep-memory-init` | 메모리 루트 + 프로젝트 프로필 초기화 |
| `deep-memory-harvest` | 형제 산출물 스캔 → 증류 → 영속화 |
| `deep-memory-brief` | 작업별 top-N 메모리 브리프 |
| `deep-memory-audit` | 스키마/오래됨/리댁션/잠금/promote 감사 |
| `memory-schema` (레퍼런스) | M3 envelope + 카드 스키마 + 상태 머신 |

## 프라이버시

- 3패스 규칙 기반 리댁션 (Step A 입력 / Step B 입력 / envelope 래핑)
- 카드별 기본값 `privacy_level: local`; `--promote <id>`는 전역 메모리로 가는 유일한 경로
- 사용자 정의 거부 패턴을 위한 `suppressions.yaml`

## 크로스 런타임

동일한 스킬이 Claude Code(슬래시), Codex(`$deep-memory:...`), Copilot CLI, Gemini CLI, Agent SDK(`Skill({skill:"deep-memory:..."})`)에서 실행됩니다. LLM 증류는 호스트 어댑터(claude-agent / codex-bash / gemini-sdk / stdin-fallback)를 자동 감지합니다.

## 문서

- [Phase 4 / 5 / 6 핸드오프 (v0.1.0 이후 로드맵)](docs/handoff-phase-4-6.md)
- [CHANGELOG](CHANGELOG.md)
- [English README](README.md)

## 라이선스

MIT
