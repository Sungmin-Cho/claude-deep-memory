---
name: deep-memory-init
description: "Initialize the deep-memory plugin for first use — preflight memory_root (realpath / writability / NFS / sqlite probe), write config.yaml with schema validation, create ~/.deep-memory/projects/<project_id>.json + project-local .deep-memory/project-profile.json. Triggers on `/deep-memory-init`, \"init memory\", \"deep memory setup\", \"메모리 초기화\", \"deep-memory 셋업\". Optional arg: `<memory_root>` (default ~/.deep-memory/, override via DEEP_MEMORY_ROOT env), and `--allow-network-root` to explicitly allow NFS/network mounts."
user-invocable: true
---

# deep-memory-init — Initialize deep-memory

Set up the deep-memory plugin for first use — preflight the memory_root, write the default `config.yaml`, and create the project-profile mirror.

## Invocation

이 스킬은 두 가지 경로로 호출됩니다 — 어느 쪽이든 본 SKILL §"Steps" 절차를 그대로 실행합니다:

1. **Claude Code 슬래시** — 사용자가 `/deep-memory-init [memory_root] [--allow-network-root]` 입력 (skill 의 `user-invocable: true` 가 슬래시 진입을 허용).
2. **타 에이전트 / Codex / Copilot CLI / Gemini CLI / SDK** — `Skill({ skill: "deep-memory:deep-memory-init", args: "[memory_root] [--allow-network-root]" })` 형태로 명시 invoke (cross-platform 표준 경로).

두 경로 모두 args 는 동일한 토큰 문자열로 전달되며, Step 1 의 분기가 동일하게 처리합니다.

## Inputs (skill args)

| 인자 | 의미 |
|---|---|
| (없음) | 환경변수 `DEEP_MEMORY_ROOT` 또는 `~/.deep-memory/` 를 memory_root 로 사용 |
| `<memory_root>` | 절대경로 또는 `~`-prefix. POSIX form 필수 (Windows 사용자는 `/c/...` 또는 `/mnt/c/...`) |
| `--allow-network-root` | NFS / `/Volumes/` / `/mnt/` / `/net/` 경로를 명시적으로 허용 (기본 차단) |

## Prerequisites

- Node.js ≥ 18 (`node:fs`, `node:crypto` 등 stable API 사용)
- 선택: `better-sqlite3` (FTS5 lexical index — 없으면 `sql.js` fallback, 두 어댑터 모두 없으면 retrieve 가 lexical 검색을 disable 한 채 동작)

## Steps

1. **memory_root 결정**: arg > 환경변수 `DEEP_MEMORY_ROOT` > `~/.deep-memory`. `~`-prefix 는 `os.homedir()` 로 치환.
2. **preflight 호출** — `scripts/lib/preflight.js` 의 `preflight(memoryRoot, { allowNetworkRoot })` 가 다음을 검증:
   - realpath / 쓰기 가능 / 부모 디렉토리 존재
   - NFS · 네트워크 마운트 차단 (`--allow-network-root` 없으면)
   - sqlite adapter 가용성 probe (`better-sqlite3` → `sql.js` → 둘 다 없으면 warning)
   - error 발생 시 사용자 안내 후 종료 (exit 1)
3. **memory_root 하위 디렉토리 보장**: `cards/`, `events/`, `indexes/`, `projects/`, `.leases/` (`mkdir -p` 동작).
4. **`config.yaml` 작성** — `~/.deep-memory/config.yaml` 이 없으면 default config 작성 후 schema 검증 (versions / paths / privacy block 필수).
5. **project-profile 생성** —
   - `proj_<sha256(remote_url_hash + root_path_hash)[:12]>` 형식의 `project_id` 계산
   - `.deep-memory/project-profile.json` (project-local) + `~/.deep-memory/projects/<project_id>.json` (global mirror) 양쪽에 atomic write
   - languages / runtimes / suite plugins 등 signature 필드는 shallow scan 으로 채움
6. **결과 보고** — `{ memoryRoot, projectId, warnings }` JSON 출력.

위 단계 전체는 `scripts/init.js` 의 `run(opts)` 함수가 단일 진입점으로 수행합니다.

## Outputs

- `~/.deep-memory/config.yaml`
- `~/.deep-memory/{cards,events,indexes,projects,.leases}/`
- `~/.deep-memory/projects/<project_id>.json`
- `.deep-memory/project-profile.json` (project-local, gitignored)

## Privacy invariant

생성된 project-profile 의 `privacy.scope` 기본값은 `local` 입니다 — `/deep-memory-audit --promote <id>` 만이 cards 의 `privacy_level` 을 `global` 로 승격할 수 있습니다.

## Error handling

- `preflight failed: <reason>` — memory_root 미작성, sqlite probe 실패, NFS 경로 거부 등. 안내 메시지에 fix step 포함.
- `config.yaml schema invalid` — 사용자가 손으로 수정한 config 가 schema 와 어긋날 때. 변경 직전 위치 + 예상 타입 안내.
- network-mount 경고는 `--allow-network-root` 로 우회 가능하지만 default behavior 가 변하지 않도록 explicit opt-in 유지.

## See also

- `deep-memory-harvest` — 인제스트 진입 skill
- `deep-memory-brief` — top-N 메모리 회상 skill
- `deep-memory-audit` — schema · stale · lock · promotion 점검 skill
- `memory-schema` — schema invariants 참조 skill (sibling)
