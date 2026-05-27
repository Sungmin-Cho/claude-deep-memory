[English](./README.md) | **한국어**

# deep-memory

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-memory?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-memory)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

> [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)를 위한 크로스 프로젝트 시맨틱 운영 메모리.

deep-suite 형제 플러그인이 생성한 산출물을 수집하여, 재사용 가능한 메모리 카드(하이브리드: 규칙 기반 + LLM 서브에이전트)로 증류하고, 이후 작업이 회상할 수 있도록 작업별 메모리 브리프를 제공합니다: 3계층 메모리 모델(Events → Cards → Briefs), 크로스 런타임 hook capture(옵트인), 하이브리드 검색(FTS5 + 벡터), slash 전용 mutation 게이트를 가진 MCP 서버. 릴리스 이력은 [CHANGELOG](CHANGELOG.md)를 참고하세요.

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

#    선택: 자동 hook capture 옵트인 (기본 OFF — 전역 토글)
/deep-memory-init --enable-capture     # ...다시 끄려면 --disable-capture

# 2. 현재 프로젝트의 형제 플러그인 산출물을 수집
/deep-memory-harvest

# 3. 다가오는 작업에 대한 메모리 브리프 조회
/deep-memory-brief "implement Codex-compatible plugin manifest"

# 4. 주기적 감사 (오래된 메모리, 스키마 드리프트, 잠금 복구)
/deep-memory-audit
```

자동 hook capture 는 **기본 OFF** 입니다 (도구 입출력을 `~/.deep-memory/events/` 에
기록하므로 명시적 옵트인 필요). `--enable-capture` 는 전역 단일 `config.yaml` 에
`capture.enabled: true` 를 기록하므로 토글은 **모든 워크스페이스에 적용**됩니다 — 단
기록된 이벤트·카드는 작업 중인 `project_id` 로 태깅되고 `privacy_level: local` 이
기본이라 프로젝트별로 격리됩니다. 수동 경로(`/deep-memory-harvest`,
`/deep-memory-brief`)는 capture 를 꺼둔 채로도 동작합니다.

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
- 자동 hook capture 는 **기본 OFF**; `/deep-memory-init --enable-capture` 로 옵트인(`--disable-capture` 로 해제). 실제 토글이 일어날 때마다 `capture-toggle` audit-log 1건 기록
- 사용자 정의 거부 패턴을 위한 `suppressions.yaml`

## 크로스 런타임

동일한 스킬이 Claude Code(슬래시), Codex(`$deep-memory:...`), Copilot CLI, Gemini CLI, Agent SDK(`Skill({skill:"deep-memory:..."})`)에서 실행됩니다. LLM 증류는 호스트 어댑터(claude-agent / codex-bash / gemini-sdk / stdin-fallback)를 자동 감지합니다.

## 트러블슈팅

### `/deep-memory-harvest` 또는 `/deep-memory-brief` 에 `FTS5 lexical index unavailable` 경고가 뜨면

현재 Node 런타임에서 `better-sqlite3` 가 로드되지 않았다는 뜻입니다. 흔한 원인:

- **Node v26+** — 최신 Node 릴리스용 better-sqlite3 prebuilt binary 가 아직
  배포되지 않았을 수 있고, 마켓플레이스 플러그인 캐시는 immutable (즉석 재빌드 불가).
  harvest 는 cards/events 를 디스크에 정상 기록하지만 FTS5 인덱스 갱신은 skip
  되고 `/deep-memory-brief` 는 빈 결과를 반환합니다.
- **빌드 툴체인 부재** — 캐시 비우고 source 에서 직접 빌드하려는 경우
  Python 3, C++ 컴파일러, make 가 필요합니다.

`better-sqlite3` 가 기본 SQLite 드라이버이며, `sql.js`(WASM)가 선택적 fallback
의존성으로 함께 제공됩니다. 따라서 native module 이 없을 때 크래시 대신 검색이
graceful 하게 degrade 됩니다.

**우회 방법**: Node 22 LTS 사용 — `nvm install 22 && nvm use 22` — 후
`/deep-memory-harvest` 를 다시 실행하세요.

## 라이선스

MIT
