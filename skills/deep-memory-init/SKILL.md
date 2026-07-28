---
name: deep-memory-init
description: "Initialize deep-memory — preflight `memory_root`, write and schema-validate `config.yaml`, create the profile pair. Triggers on `/deep-memory-init`, \"init memory\", \"deep memory setup\", \"메모리 초기화\", \"deep-memory 셋업\". Args: `<memory_root>`, `--allow-network-root`, `--enable-capture` / `--disable-capture` (capture defaults OFF)."
user-invocable: true
---

# deep-memory-init — Initialize deep-memory

Set up the deep-memory plugin for first use — preflight the memory_root, write the default `config.yaml`, and create the project-profile mirror.

호출: `/deep-memory-init [memory_root] [--allow-network-root] [--enable-capture | --disable-capture]` (Claude Code 슬래시) 또는 `Skill({ skill: "deep-memory:deep-memory-init", args: "[memory_root] [--allow-network-root] [--enable-capture | --disable-capture]" })` (Codex / 타 에이전트 / SDK). 두 경로 모두 같은 토큰 문자열을 받아 Step 1 의 분기로 들어갑니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | 환경변수 `DEEP_MEMORY_ROOT` 또는 `~/.deep-memory/` 를 memory_root 로 사용 |
| `<memory_root>` | 절대경로 또는 `~`-prefix. Windows 에서는 `C:\Users\me\.deep-memory` 같은 native 경로를 그대로 사용 |
| `--allow-network-root` | NFS / `/Volumes/` / `/mnt/` / `/net/` / Windows UNC 경로를 명시적으로 허용 (기본 차단, UNC 도 이 플래그 필요) |
| `--enable-capture` | 자동 hook capture 를 켬 (`config.yaml#capture.enabled: true`). 전역 토글 — 기본값 OFF |
| `--disable-capture` | 자동 hook capture 를 끔. `--enable-capture` 와 동시 지정 시 exit 1 (mutually exclusive) |

## Prerequisites

- Node.js 22 이상 (`package.json#engines` 계약)
- 선택: `better-sqlite3` (native FTS5 lexical index). 로드할 수 없으면 retrieval 은 bounded privacy-scoped card scan 으로 안전하게 fallback.

## Steps

전체는 `${CLAUDE_PLUGIN_ROOT}/scripts/init.js` 의 `run(opts)` 가 단일 진입점으로 수행합니다.

1. **memory_root 결정**: arg > 환경변수 `DEEP_MEMORY_ROOT` > `~/.deep-memory`. `~`-prefix 는 `os.homedir()` 로 치환.
   - Windows 예: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.js" "C:\Users\me\.deep-memory"`
   - UNC 예: `node "${CLAUDE_PLUGIN_ROOT}/scripts/init.js" "\\server\share\deep-memory" --allow-network-root` (명시적 opt-in 필수)
2. **preflight 호출** — `${CLAUDE_PLUGIN_ROOT}/scripts/lib/preflight.js` 의 `preflight(memoryRoot, { allowNetworkRoot })`:
   - memory_root 를 `mkdir -p` 로 만든 뒤 realpath 로 정규화 (부모 디렉토리는 검사가 아니라 생성 대상입니다)
   - 정규화된 경로에 임시 파일을 쓰고 fsync 후 지우는 **쓰기 probe**. 실패해도 abort 하지 않고 `readOnly` warning ("brief-only mode") 만 남깁니다 — 이 단계는 게이트가 아닙니다.
   - 네트워크 루트 차단 — POSIX 는 `/Volumes/` · `/mnt/` · `/net/` prefix, Windows 는 UNC (`\\server\share`, `\\?\UNC\...`) 를 **경로 패턴으로** 판정합니다. 파일시스템 타입을 조회하지 않으므로 그 prefix 밖에 마운트된 NFS 는 걸리지 않습니다.
   - init 을 실제로 중단시키는 것은 이 네트워크 루트 거부뿐입니다 (`preflight failed: ...` 로 throw).
   - native FTS5 adapter 가용성은 여기서 판단하지 않고 harvest/retrieve 시 별도로 결정합니다.
3. **memory_root 하위 디렉토리 보장**: `cards/`, `events/`, `indexes/`, `projects/`, `.leases/`.
4. **`config.yaml` 작성** — 없으면 default config 작성 후 schema 검증 (versions / paths / privacy block 필수). default 는 `capture: {enabled: false, eager_distill: false}` 를 포함합니다.
5. **project-profile 생성** —
   - canonical physical root 문자열만을 해시하는 root-only `proj_<sha256(canonical_root)[:12]>` 형식의 `project_id` 계산
   - `.deep-memory/project-profile.json` (project-local) + `~/.deep-memory/projects/<project_id>.json` (global mirror) 양쪽에 atomic write
   - languages / runtimes / suite plugins 등 signature 필드는 shallow scan 으로 채움
6. **capture 토글** (플래그 지정 시) — `${CLAUDE_PLUGIN_ROOT}/scripts/lib/capture-toggle.js` 의 `setCaptureEnabled` 가 `config.yaml#capture.enabled` 줄만 in-place 편집합니다. 실제 상태 전이(true↔false)가 일어날 때만 `audit-log/YYYY-MM.jsonl` 에 `{kind:'capture-toggle', by:'cli-flag', payload:{from,to,method:'cli-flag'}}` 1건을 기록합니다 — 이미 같은 상태면 무변경·무기록 (멱등).
7. **결과 보고** — `{ memoryRoot, projectId, warnings }` (+ 토글 시 `capture: {from, to, changed}`) JSON 출력.

## Outputs

- `~/.deep-memory/config.yaml` (capture 토글 시 `capture.enabled` 갱신)
- `~/.deep-memory/{cards,events,indexes,projects,.leases}/`
- `~/.deep-memory/projects/<project_id>.json`
- `.deep-memory/project-profile.json` (project-local, gitignored)
- `~/.deep-memory/audit-log/YYYY-MM.jsonl` (capture 상태 전이 시 `capture-toggle` 1건)

## Privacy invariant

project-profile 의 `privacy.scope` 기본값은 `local` 이며, cards 의 `privacy_level` 을 `global` 로 올릴 수 있는 것은 `/deep-memory-audit --promote <id>` (또는 `/deep-memory-promote`) 뿐입니다.

자동 hook capture 는 **기본 OFF** 입니다 — 도구 입출력을 `~/.deep-memory/events/` 에 기록하므로 명시적 opt-in 을 요구합니다. capture 토글은 전역 단일 `config.yaml` 에 저장되어 **모든 워크스페이스에 적용**됩니다. 다만 기록된 이벤트·카드는 작업 중인 `project_id` 로 태깅되고 `privacy_level: local` 이라 프로젝트별로 격리됩니다.

## Error handling

- `preflight failed: <reason>` — network root 거부. 현재 preflight 가 `ok: false` 를 내는 경우는 이것뿐이며, 쓰기 probe 실패는 warning 으로 남고 init 은 계속 진행합니다.
- `config.yaml schema invalid` — 손으로 고친 config 가 schema 와 어긋날 때. 변경 직전 위치 + 예상 타입 안내.
- network-mount 경고는 `--allow-network-root` 로 우회할 수 있지만 default behavior 는 바뀌지 않도록 explicit opt-in 을 유지합니다.

## See also

`deep-memory-harvest` (인제스트) · `deep-memory-brief` (top-N 회상) · `deep-memory-audit` (schema · stale · lock · promotion 점검)
