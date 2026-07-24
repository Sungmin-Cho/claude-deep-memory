# Changelog

deep-memory의 모든 주요 변경 사항을 기록합니다. [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 및 [Semantic Versioning](https://semver.org/spec/v2.0.0.html) 형식을 따릅니다.

## [1.0.5] — 2026-07-24

### Fixed

- 마켓플레이스에 설치된 capture hook이 이제 `node_modules` 없이 self-contained bundle에서 실행되고 runtime 시작 오류에도 fail open하므로, 활성화된 capture가 계속 동작하면서 Claude Code나 Codex에 hook 실패를 표시하지 않습니다.

## [1.0.4] — 2026-07-20

### Fixed

- Claude Code는 manifest에 선언한 hook 파일 외에 표준 `hooks/hooks.json`도 자동 로드하므로, Codex 발견용 hook이 Claude Code에서도 실행되어 `${PLUGIN_ROOT}` 미설정 상태로 모든 SessionStart, UserPromptSubmit, PostToolUse, PreCompact에서 실패했습니다("Failed with non-blocking status code: node:internal/modules/cjs/loader:1478"). 이제 Codex hook도 Claude 파일과 동일한 shell-safe fail-open env-bootstrap이며 Claude 호스트에서는 `hooks/hooks.claude.json`에 위임하므로, 각 이벤트는 런타임당 정확히 한 번만 capture되고 호스트 에러가 표시되지 않습니다.

## [1.0.3] — 2026-07-20

### Fixed

- Claude Code capture hook이 이제 전용 hook manifest에서 로드되고 런타임에 플러그인 루트를 해석하므로, 호스트가 인라인 manifest hook에서 플러그인 루트 토큰을 확장하지 않아 조용히 실패하던 대신 모든 세션의 SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, PreCompact, SessionEnd capture가 정상 실행됩니다.
- capture hook은 계속 non-blocking이며 fail open입니다. 플러그인 루트 부재, capture 스크립트 부재, spawn 오류 시 세션을 방해하지 않고 capture를 건너뜁니다.

## [1.0.2] — 2026-07-10

### Changed

- Claude Code와 Codex는 명시적 호스트 중개 distiller contract를 사용하며, mediation을 사용할 수 없거나 timeout 또는 거부되면 candidate 카드로 명시적으로 fallback합니다.
- Claude Code는 6개 hook 이벤트를 유지하고 Codex는 네이티브 Windows 명령과 같은 capture 의미를 사용하는 4개 지원 이벤트만 사용합니다.
- 업그레이드 후 모든 워크스페이스를 초기화하고 다시 하베스트하세요. 이전 범위 산출물은 자동으로 마이그레이션되지 않고, 다시 하베스트할 수 없는 레거시 카드는 이전 범위에 보관되므로 해당하면 업그레이드 전에 내보내기 또는 백업하세요.

### Fixed

- Codex MCP는 플러그인 상대 경로의 bundled entrypoint로 시작하고 설치 시점 의존성 없이 bundled schema와 resource를 읽습니다.
- 네이티브 SQLite를 사용할 수 없으면 MCP와 명령행 읽기가 프라이버시 범위 bounded card scan을 사용합니다.

## [1.0.1] - 2026-07-09

### Fixed

- 마켓플레이스 설치물이 runtime 의존성 설치 없이 MCP 핸드셰이크를 완료하고 도구 목록을 제공합니다.
- 선택적 네이티브 검색 구성요소는 해당 기능이 요청될 때만 로드되어 MCP 시작 경로가 가볍습니다.

## [1.0.0] - 2026-07-09

### Fixed

- Codex가 네이티브 hook manifest에서 호스트 지원 capture hook을 발견합니다.
- Runtime producer 메타데이터가 설치된 플러그인 버전과 동기화됩니다.

## [0.4.0] - 2026-07-07

### Fixed

- 범위가 적용된 카드를 해결할 수 없으면 MCP 읽기가 빈 성공 대신 fail-closed로 동작합니다.
- 지연된 증류가 월별 이벤트 rollover에서도 손실 없는 파일과 offset 커서를 유지합니다.
- 세션 capture가 live 세션 상태를 변경하거나 폐기하지 않습니다.
- Harvest 경고와 native-loader 실패가 노출 전에 리댓션되고 길이가 제한됩니다.

## [0.3.2] - 2026-05-25

### Added

- 초기화에서 기본으로 꺼져 있는 전역 capture 토글을 명시적으로 켜거나 끄는 기능을 제공합니다.
- 실제 capture 토글 전환마다 감사 기록 1건을 남기고 no-op 요청은 기록하지 않습니다.

### Fixed

- 문서에 안내된 capture 옵트인을 설정을 수동 편집하지 않고 사용할 수 있습니다.

## [0.3.1] - 2026-05-22

### Fixed

- MCP가 호스트에 지원되지 않는 shell 스타일 기본값 보간을 전달하지 않아 시작 핸드셰이크 실패를 방지합니다.
- 이 패치 릴리스는 영향받은 cache 설치물이 수정된 MCP 설정을 다시 가져오도록 합니다.

## [0.3.0] - 2026-05-22

### Added

- Events, Cards, Briefs 3계층 모델에 옵트인 hook capture, 결정론적 카드 추출, 하이브리드 검색, gate가 적용된 MCP 표면을 추가합니다.
- Claude Code는 6개 생명주기 이벤트를, Codex는 capture 활성화 후 지원하는 4개 이벤트 subset을 캡처합니다.
- 읽기 전용 메모리 도구와 명시적 gate가 적용된 내보내기, 승격, 삭제 스킬을 지원 호스트에서 사용할 수 있습니다.

### Changed

- 리댓션 규칙을 capture, 증류, 검색, 출력 경계에서 공유합니다.
- 이벤트 커서가 전진 전용 바이트 offset을 사용하며 레거시 flat event와 호환됩니다.

## [0.1.3] - 2026-05-21

### Fixed

- Degraded-mode 경고가 카드나 요약에 도달하기 전에 홈 디렉터리 정보를 리댓션합니다.
- 네이티브 SQLite는 설치 시점의 선택 사항이며, 네이티브 binding을 사용할 수 없어도 플러그인을 시작할 수 있습니다.

## [0.1.2] - 2026-05-21

### Fixed

- 네이티브 FTS5를 로드할 수 없어도 harvest가 카드와 이벤트를 기록하고 조치 가능한 degraded-mode 경고를 노출합니다.
- 모든 형제 산출물 mapper가 실제 emit 형태를 소비하여 유효한 소스가 카드 0개로 조용히 종료되지 않습니다.

### Changed

- 이전의 이상화된 mapper 형태로 수작업한 산출물은 재생성해야 하며, 영속화 카드와 envelope 형식은 변하지 않습니다.

## [0.1.0] - 2026-05-20

### Added

- Claude Code와 Codex manifest가 초기화, harvest, brief, audit 스킬을 제공합니다.
- 규칙 기반 추출과 선택적 subagent 정제가 명시적 candidate fallback과 함께 리댓션된 로컬 메모리 카드를 생성합니다.
- 프로젝트 lease, 원자적 쓰기, 범위 저장소, 명시적 승격으로 메모리 무결성과 프라이버시를 보호합니다.

### Changed

- 초기 어휘 색인은 단일 프로젝트에서 안전하며, 하나의 저장소를 여러 프로젝트가 공유하는 사용자는 범위 인식 색인이 제공될 때까지 별도 메모리 루트를 사용해야 합니다.
