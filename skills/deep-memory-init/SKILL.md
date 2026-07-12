---
name: deep-memory-init
description: "Initialize the deep-memory plugin for first use — preflight memory_root (realpath / writability / filesystem write probe / network-root guard), write config.yaml with schema validation, create ~/.deep-memory/projects/<project_id>.json + project-local .deep-memory/project-profile.json. Triggers on `/deep-memory-init`, \"init memory\", \"deep memory setup\", \"메모리 초기화\", \"deep-memory 셋업\". Optional arg: `<memory_root>` (default ~/.deep-memory/, override via DEEP_MEMORY_ROOT env), `--allow-network-root` to explicitly allow NFS/network mounts, and `--enable-capture` / `--disable-capture` to toggle automatic hook capture (default OFF)."
user-invocable: true
---

# deep-memory-init — Initialize deep-memory

Set up the deep-memory plugin for first use — preflight the memory_root, write the default `config.yaml`, and create the project-profile mirror.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — 사용자가 `/deep-memory-init [memory_root] [--allow-network-root] [--enable-capture | --disable-capture]` 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-memory:deep-memory-init", args: "[memory_root] [--allow-network-root] [--enable-capture | --disable-capture]" })` 형태로 명시 invoke (cross-platform 표준 경로).

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, Step 1 의 분기가 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | 환경변수 `DEEP_MEMORY_ROOT` 또는 `~/.deep-memory/` 를 memory_root 로 사용 |
| `<memory_root>` | 절대경로 또는 `~`-prefix. Windows 에서는 `C:\Users\me\.deep-memory` 같은 native 경로를 그대로 사용 |
| `--allow-network-root` | NFS / `/Volumes/` / `/mnt/` / `/net/` / Windows UNC 경로를 명시적으로 허용 (기본 차단, UNC 도 `--allow-network-root` 필요) |
| `--enable-capture` | 자동 hook capture 를 켬 (`config.yaml#capture.enabled: true`). 모든 워크스페이스에 적용되는 전역 토글. 기본값은 OFF (프라이버시) |
| `--disable-capture` | 자동 hook capture 를 끔. `--enable-capture` 와 동시 지정 시 exit 1 (mutually exclusive) |

## Prerequisites

- Node.js 22 이상 (`package.json#engines` 계약)
- 선택: `better-sqlite3` (native FTS5 lexical index). 로드할 수 없으면 retrieval 은 bounded privacy-scoped card scan 으로 안전하게 fallback.

## Steps

1. **memory_root 결정**: arg > 환경변수 `DEEP_MEMORY_ROOT` > `~/.deep-memory`. `~`-prefix 는 `os.homedir()` 로 치환.
   - Windows 예: `node scripts/init.js "C:\Users\me\.deep-memory"`
   - UNC 예: `node scripts/init.js "\\server\share\deep-memory" --allow-network-root` (명시적 opt-in 필수)
2. **preflight 호출** — `scripts/lib/preflight.js` 의 `preflight(memoryRoot, { allowNetworkRoot })` 가 다음을 검증:
   - realpath / 쓰기 가능 / 부모 디렉토리 존재
   - NFS · 네트워크 마운트 차단 (`--allow-network-root` 없으면)
   - memory root 자체의 쓰기 가능성 probe (native FTS5 adapter 가용성은 harvest/retrieve 시 별도 판단)
   - error 발생 시 사용자 안내 후 종료 (exit 1)
3. **memory_root 하위 디렉토리 보장**: `cards/`, `events/`, `indexes/`, `projects/`, `.leases/` (`mkdir -p` 동작).
4. **`config.yaml` 작성** — `~/.deep-memory/config.yaml` 이 없으면 default config 작성 후 schema 검증 (versions / paths / privacy block 필수). default 에는 `capture: {enabled: false, eager_distill: false}` 블록이 포함됨 (capture 기본 OFF).
5. **project-profile 생성** —
   - canonical physical root 문자열만을 해시하는 root-only `proj_<sha256(canonical_root)[:12]>` 형식의 `project_id` 계산
   - `.deep-memory/project-profile.json` (project-local) + `~/.deep-memory/projects/<project_id>.json` (global mirror) 양쪽에 atomic write
   - languages / runtimes / suite plugins 등 signature 필드는 shallow scan 으로 채움
6. **capture 토글** (`--enable-capture` / `--disable-capture` 지정 시) — `scripts/lib/capture-toggle.js` 의 `setCaptureEnabled` 가 `config.yaml#capture.enabled` 를 in-place 편집 (기존 config 도 덮어쓰지 않고 해당 줄만 수정). 실제 상태 전이(true↔false)가 일어날 때만 `audit-log/YYYY-MM.jsonl` 에 `{kind:'capture-toggle', by:'cli-flag', payload:{from,to,method:'cli-flag'}}` 1건 기록 (멱등 — 이미 같은 상태면 무변경·무기록).
7. **결과 보고** — `{ memoryRoot, projectId, warnings }` (+ 토글 시 `capture: {from, to, changed}`) JSON 출력.

위 단계 전체는 `scripts/init.js` 의 `run(opts)` 함수가 단일 진입점으로 수행합니다.

## Outputs

- `~/.deep-memory/config.yaml` (capture 토글 시 `capture.enabled` 갱신)
- `~/.deep-memory/{cards,events,indexes,projects,.leases}/`
- `~/.deep-memory/projects/<project_id>.json`
- `.deep-memory/project-profile.json` (project-local, gitignored)
- `~/.deep-memory/audit-log/YYYY-MM.jsonl` (capture 상태 전이 시 `capture-toggle` 1건)

## Privacy invariant

생성된 project-profile 의 `privacy.scope` 기본값은 `local` 입니다 — `/deep-memory-audit --promote <id>` 만이 cards 의 `privacy_level` 을 `global` 로 승격할 수 있습니다.

자동 hook capture 는 **기본 OFF** 입니다 (도구 입출력을 `~/.deep-memory/events/` 에 기록하므로 명시적 opt-in 요구). `--enable-capture` 로 켜는 capture 토글은 전역 단일 `config.yaml` 에 저장되어 **모든 워크스페이스에 적용**됩니다 — 단, 기록된 이벤트·카드는 작업 중인 `project_id` 로 태깅 + `privacy_level: local` 이라 프로젝트별로 격리됩니다.

## Error handling

- `preflight failed: <reason>` — memory_root 미작성, filesystem write probe 실패, NFS/UNC network root 거부 등. 안내 메시지에 fix step 포함. Native FTS5 adapter 가용성은 init preflight 가 아니라 harvest/retrieve 시 별도 판단.
- `config.yaml schema invalid` — 사용자가 손으로 수정한 config 가 schema 와 어긋날 때. 변경 직전 위치 + 예상 타입 안내.
- network-mount 경고는 `--allow-network-root` 로 우회 가능하지만 default behavior 가 변하지 않도록 explicit opt-in 유지.

## See also

- `deep-memory-harvest` — 인제스트 진입 skill
- `deep-memory-brief` — top-N 메모리 회상 skill
- `deep-memory-audit` — schema · stale · lock · promotion 점검 skill
- `memory-schema` — schema invariants 참조 skill (sibling)
