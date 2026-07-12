[English](./README.md) | **한국어**

# deep-memory

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-memory?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-memory)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

> [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)를 위한 크로스 프로젝트 시맨틱 운영 메모리.

deep-memory는 형제 플러그인 산출물을 하베스트하여 재사용 가능한 메모리 카드로 증류하고, 이후 작업에 작업별 브리프를 제공합니다. Claude Code와 Codex를 네이티브로 지원하며 capture는 명시적 옵트인과 프로젝트 범위를 유지합니다. 릴리스 이력은 [CHANGELOG](CHANGELOG.ko.md)에서 확인할 수 있습니다.

## 설치

Node 22가 필요합니다. 네이티브 Windows 11, macOS, Linux를 지원하며 Windows에서 Git Bash는 필요하지 않습니다.

### Claude Code

```text
/plugin install deep-memory@claude-deep-suite
```

### Codex

```text
codex plugin add deep-memory@claude-deep-suite
```

## 빠른 시작

Claude Code는 슬래시 스킬을 사용합니다.

```text
/deep-memory-init
/deep-memory-harvest
/deep-memory-brief "Codex 호환 플러그인 구현"
/deep-memory-audit
```

Codex는 네임스페이스 스킬을 사용합니다.

```text
$deep-memory:deep-memory-init
$deep-memory:deep-memory-harvest
$deep-memory:deep-memory-brief "Codex 호환 플러그인 구현"
$deep-memory:deep-memory-audit
```

자동 hook capture는 **기본 OFF**입니다. init 스킬의 `--enable-capture` 옵션으로 명시적으로 활성화하며, capture를 끄고도 수동 하베스트와 브리프 흐름은 작동합니다.

## 3계층 모델

1. **Events** — append-only 캡처 또는 하베스트 관찰.
2. **Cards** — 리댓션된 프로젝트 범위 시맨틱 메모리와 손실 회피 생명주기 상태.
3. **Briefs** — 네이티브 FTS5 또는 bounded card-scan fallback으로 생성하는 작업 문맥.

## 스킬

| 스킬 | 목적 |
|---|---|
| `deep-memory-init` | 메모리 루트와 신뢰 할 수 있는 프로젝트 프로필 초기화 |
| `deep-memory-harvest` | 형제 산출물 매핑, 선택적 Step B 정제, 카드 영속화 |
| `deep-memory-brief` | 범위가 적용된 작업 브리프 검색 |
| `deep-memory-audit` | 스키마, 생명주기, 잠금, 저장소 상태 점검 |
| `deep-memory-export` | 백업 또는 전송을 위한 카드 내보내기 |
| `deep-memory-promote` | 명시적으로 선택한 로컬 카드 승격 |
| `deep-memory-forget` | 명시적으로 확인한 카드 삭제 |

## 프라이버시

- 세 리댓션 경계가 소스 입력, 호스트 중개 정제 입력, 영속화 출력을 보호합니다.
- 새 카드는 `privacy_level: local`이 기본이며 승격은 명시적입니다.
- Capture는 **기본 OFF**이고 실제 토글 변경은 모두 감사 기록에 남습니다.
- 호스트 중개 Step B는 리댓션된 이벤트 초안과 4,096 UTF-8 바이트 이하의 리댓션된 발췌만 받습니다.

## 크로스 런타임

- Claude Code는 6개 hook 이벤트를 유지하고 Codex는 호스트가 지원하는 4개 이벤트를 사용합니다. 두 표면은 같은 capture 의미와 네이티브 Node 명령을 공유합니다.
- Claude Code는 Step B를 이름 있는 읽기 전용 distiller agent로 보내고, Codex는 같은 권위 있는 agent contract를 먼저 읽는 generic subagent로 보냅니다.
- Mediator는 shell을 사용하지 않는 명시적 JSON 실행 프로세스 contract입니다. 없거나 잘못되었거나 timeout된 mediation은 candidate fallback으로 기록됩니다.
- 네이티브 FTS5가 기본 어휘 색인입니다. 네이티브 SQLite를 사용할 수 없으면 빈 브리프 대신 프라이버시 범위 bounded card-scan fallback을 사용합니다.

## 지원 및 복구

업그레이드 후 모든 워크스페이스를 초기화하고 다시 하베스트하세요. 이전 범위 산출물은 자동으로 마이그레이션되거나 재연결되지 않고, 다시 하베스트할 수 없는 레거시 카드는 이전 범위에 보관됩니다. 해당하는 카드는 업그레이드 전에 내보내기 또는 백업하세요.

네이티브 Windows 11, macOS, Linux에서 Node 22를 사용하세요. 호스트 mediator를 사용할 수 없어도 하베스트는 candidate를 영속화하고 `.deep-memory/latest-harvest.json`에 typed warning을 기록합니다. 보안 신고는 [SECURITY.md](SECURITY.md)를 확인하세요.

## 링크

- [릴리스 이력](CHANGELOG.ko.md)
- [기여 가이드](CONTRIBUTING.md)
- [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)

## 라이선스

MIT
