# deep-memory v0.1.x — Immediate follow-up handoff

> Companion to `docs/handoff-phase-4-6.md`. That file describes the **v0.2.0+
> roadmap** (writer integration / reasoning graph / dashboard telemetry). This
> file is the **v0.1.x immediate follow-up** — what to do RIGHT NOW after v0.1.0
> shipped, prioritised by first-user impact.

## Current state (commit 48010e1)

- v0.1.0 published: https://github.com/Sungmin-Cho/claude-deep-memory
- deep-suite catalog entry merged: `68ff717` on https://github.com/Sungmin-Cho/claude-deep-suite
- 244 tests PASS / 0 fail
- 5-round deep-review-loop convergence (31 fixes, 84 new tests, 5 group commits)
- Known limitations documented in CHANGELOG.md + CHANGELOG.ko.md (C-R1) and 12 carried 🟡 in v0.1.x backlog

## Critical follow-up (discovered post-ship)

End-to-end smoke against actual sibling-plugin fixtures revealed **4 of 5 Step A
mappers do not match the sibling's real `payload` shape**. v0.1.0 produces
silent 0-card harvest even when sibling artifacts are present. Root cause: spec
§7.1 was authored from ideal shapes; sibling fixtures were never cross-checked
during Phase 0 Task 1.0a (envelope compat probe checked the envelope, not the
payload domain).

### Compatibility matrix (measured against live sibling fixtures)

| Sibling | Source | Actual emit (sibling fixture) | mapper expects | Status |
|---|---|---|---|---|
| deep-review | `.deep-review/recurring-findings.json` | `findings[].{category, severity, occurrences, example_files, description, source_reports}` | `findings[].{title, category, first_seen, evidence, tags}` | ❌ no `title` → F1 quarantine → 0 cards |
| deep-evolve | `.deep-evolve/*/evolve-insights.json` | `payload.{updated_at, insights_for_deep_work, insights_for_deep_review}` | `payload.insights[]` | ❌ `insights` undefined → 0 cards |
| deep-work | `.deep-work/*/session-receipt.json` | `payload.slices: {total, completed, spike}` (aggregate counts object) | `payload.slices[]` (array of slice objects) | ❌ not iterable. Actual per-slice data lives at `<sid>/receipts/SLICE-*.json` |
| deep-docs | `.deep-docs/last-scan.json` | `payload.documents[].issues[]` | `payload.drifts[]` | ❌ `drifts` undefined → 0 cards |
| deep-wiki | `<wiki_root>/.wiki-meta/index.json` | `payload.pages[]` (wrap-script enforces) | `payload.pages[]` (ADR filter) | ✅ shape compatible — depends on ADR-tagged pages existing in wiki |

### Reference fixtures (local paths — used to verify your fix)

- `/Users/sungmin/Dev/claude-plugins/deep-review/tests/fixtures/sample-recurring-findings.json`
- `/Users/sungmin/Dev/claude-plugins/deep-evolve/tests/fixtures/sample-evolve-insights.json`
- `/Users/sungmin/Dev/claude-plugins/deep-work/tests/fixtures/sample-session-receipt.json` (+ `sample-slice-receipt.json`)
- `/Users/sungmin/Dev/claude-plugins/deep-docs/tests/fixtures/sample-last-scan.json`
- `/Users/sungmin/Dev/claude-plugins/deep-wiki/hooks/scripts/wrap-index-envelope.js` (no fixture, but the script enforces `pages[]`)

## Other v0.1.x follow-up

### v0.1.1 — better-sqlite3 graceful degradation
- Node v26+ environments cannot install better-sqlite3 prebuilt + plugin cache
  is immutable → harvest hard-throws at `require('./lib/fts-index')`.
- Round-5 ITEM-4 (hard-throw on FTS5 require failure) was the wrong posture
  for environments where the user can't fix the build. Reverse to "graceful
  degraded mode": harvest writes cards/events, FTS5 upsert is skipped with
  an explicit warning. brief returns empty + warning. retrieval is broken
  but harvest is not — sql.js WASM fallback deferred to v0.2.0.
- Single-commit fix (~30 lines). See "Track T2" prompt below.

### v0.1.x backlog (carried from review-loop rounds 1-5)
12 🟡 items + 1 spec-text — all documented at line-level in
`.deep-review/reports/2026-05-21-114006-review.md`. None block release; some
are 1-line fixes worth bundling with T1.

## Recommended track sequence

| Order | Track | Why this order |
|---|---|---|
| 1 | **T1 — mapper shape alignment** | Restores the plugin's core value. Without it, harvest is functionally inert. Required before any consumer (incl. deep-work integration) is meaningful. |
| 2 | **T2 — v0.1.1 graceful FTS5 degradation** | Unblocks Node v26+ users. Same-repo fix, small. Should ship as v0.1.1 immediately after T1 or bundled. |
| 3 | **T3 — deep-work consumer integration** | Implements the spec §14.2 deep-work-side handoff. Requires brief.md to actually have content (= T1 done). Cross-repo work in `/Users/sungmin/Dev/claude-plugins/deep-work/`. |

After T1 + T2: tag v0.1.2 (or v0.2.0 if T1 is breaking-change-shaped). Update
deep-suite marketplace SHA. Then proceed to T3.

---

## Track T1 — Mapper shape alignment prompt

Open a new Claude Code session in `/Users/sungmin/Dev/claude-plugins/deep-memory/` and paste:

```
deep-memory v0.1.0 mapper shape alignment 작업 시작.

## Context
- 작업 디렉토리: /Users/sungmin/Dev/claude-plugins/deep-memory/ (HEAD = 48010e1)
- Discovered: 5 mapper 중 4 mapper의 payload expectation이 sibling 실제 emit shape과 mismatch.
  zero-card silent fail. spec §7.1이 ideal-shape으로 설계되고 sibling fixture로 검증 안 됨.
- 문서: docs/handoff-v0.1.x-immediate.md §"Compatibility matrix" — 5개 mapper 별
  실제 sibling shape vs mapper expectation 표.

## Sibling 실제 fixture paths (재구현 기준)
- /Users/sungmin/Dev/claude-plugins/deep-review/tests/fixtures/sample-recurring-findings.json
- /Users/sungmin/Dev/claude-plugins/deep-evolve/tests/fixtures/sample-evolve-insights.json
- /Users/sungmin/Dev/claude-plugins/deep-work/tests/fixtures/sample-session-receipt.json
- /Users/sungmin/Dev/claude-plugins/deep-work/tests/fixtures/sample-slice-receipt.json (deep-work는
  slice 단위 분리 emit 패턴 — session-receipt는 aggregate object, 실제 slice data는
  <sid>/receipts/SLICE-*.json. mapper가 session-receipt에서 slices[]를 읽는 대신
  slice-receipt를 source로 받도록 변경 필요할 수도)
- /Users/sungmin/Dev/claude-plugins/deep-docs/tests/fixtures/sample-last-scan.json
- /Users/sungmin/Dev/claude-plugins/deep-wiki/hooks/scripts/wrap-index-envelope.js (script가
  payload.pages[] 보장)

## Task

### 1. mapper rewrite — 4 functions
scripts/harvest.js의 4 mapper를 sibling 실제 shape으로 재구현:

(a) **mapRecurringFindings** — finding.{category, severity, occurrences, example_files,
    description, source_reports} 기반.
    - claim source: finding.description (deterministic, F1 — never empty)
    - title: 첫 80자 truncate of description OR finding.category + " — " + 첫 60자
    - evidence_summary: finding.example_files.slice(0, 5)
    - applicability: [{value: finding.category, source_id, confidence: 0.7}]
    - tags: [finding.severity, finding.category]
    - created_at: finding.first_seen || envelope.generated_at fallback

(b) **mapEvolveInsights** — payload는 insights[]가 아니라 insights_for_deep_work[] +
    insights_for_deep_review[] 두 키. 두 array union 또는 deep_work만 사용 (spec 결정 필요).
    - 실제 insight 내부 shape는 fixture 직접 확인 (sample-evolve-insights.json은 빈 array일 수
      있으니 deep-evolve 의 schema 또는 wrap-evolve-envelope.js domain validator도 참조).

(c) **mapWorkReceipt** — session-receipt.payload.slices는 aggregate object. 실제 slice
    array는 <sid>/receipts/SLICE-*.json 별도. 두 가지 옵션:
    - Option A: source-kind='work-receipt'는 session-receipt 하나만 받고 slices object의
      success/failure count로 claim 생성 ("Session: <task_description> — <quality_score>점,
      <slices.completed>/<slices.total> slice completed").
    - Option B: source-kind='work-receipt'를 slice-receipt 단위로 변경 (config.yaml
      sources path를 '<sid>/receipts/SLICE-*.json'으로). spec §7.1 §"수정"이 필요.
    - 추천: A (single-receipt-per-session) — 깔끔. slice-level memory가 필요하면 후속 작업.

(d) **mapDocsScan** — payload.documents[].issues[] (nested). flatten:
    document별 issues[]를 펼쳐서 각 issue 1 card. claim = issue.type + " — " + issue.description.
    evidence_summary = [document.path + ":" + issue.line]. applicability = issue.category.

(e) **mapWikiIndex** — shape OK. 그대로 유지. ADR page 부재 시 자연스럽게 0 cards (정상).

### 2. tests/fixtures/ 교체
기존 tests/fixtures/sample-{recurring-findings, evolve-insights, session-receipt-*, last-scan}.json
은 ideal-shape 기준이라 모두 outdated. **sibling repo의 실제 fixture를 복사**해서 우리 tests/fixtures/로 가져오기:

  cp /Users/sungmin/Dev/claude-plugins/deep-review/tests/fixtures/sample-recurring-findings.json \\
     tests/fixtures/sample-recurring-findings.json
  cp /Users/sungmin/Dev/claude-plugins/deep-evolve/tests/fixtures/sample-evolve-insights.json \\
     tests/fixtures/sample-evolve-insights.json
  cp /Users/sungmin/Dev/claude-plugins/deep-work/tests/fixtures/sample-session-receipt.json \\
     tests/fixtures/sample-session-receipt-success.json
  cp /Users/sungmin/Dev/claude-plugins/deep-docs/tests/fixtures/sample-last-scan.json \\
     tests/fixtures/sample-last-scan.json
  # deep-wiki: ADR page 1+ 포함한 minimal index fixture 작성

### 3. golden test 재작성
tests/harvest-golden.test.js의 assertion이 mapper 출력의 정확한 claim/evidence/applicability를
검증. fixture가 바뀌면 assertion도 다시 작성. mapper별 1+ test, 5개 source kind 모두 커버.

### 4. NEW invariant test
tests/sibling-shape-smoke.test.js — sibling 실제 fixture를 모두 harvest 하고 4+ cards
생성 확인. 미래에 sibling shape이 또 바뀌어도 즉시 적색 신호.

### 5. spec §7.1 갱신
docs/superpowers/specs/2026-05-20-deep-memory-design.md §7.1 mapper rule 표를
실제 sibling shape에 맞게 다시 작성. 또는 별도 doc (docs/sibling-shape-contract.md)
신설 후 spec에서 link.

### 6. CHANGELOG.md + CHANGELOG.ko.md
## [0.1.2] - <date>  (또는 [0.2.0] if breaking)
### Fixed: mapper shape alignment — 4 of 5 Step A mappers now match
sibling plugins' actual `payload` shape. Previously, harvest produced silent
0-card output even when sibling artifacts were present. v0.1.0 fixtures
(ideal-shape) replaced with sibling-real fixtures.
### Breaking: spec §7.1 mapper expectations rewritten (consumers that hand-built
deep-memory artifacts against the old spec must regenerate).

### 7. v0.1.1 (T2)과 같은 commit으로 묶을지 결정
T1 + T2를 같은 release로 묶는 게 자연 — 둘 다 v0.1.0 first-use blocker.
v0.1.2 또는 v0.2.0 release로 tag.

### 8. deep-suite SHA bump + push
cd /Users/sungmin/Dev/claude-plugins/deep-suite
- .claude-plugin/marketplace.json + .agents/plugins/marketplace.json:
  deep-memory entry sha 갱신, description에 "v0.1.2 fixes silent 0-card harvest" 추가
- node scripts/generate-reference-sections.js --write
- npm test (catalog-drift 통과)
- commit + push

## Verification protocol
T1 끝나기 전 다음 smoke 실행:
  node -e "
  const { harvestArtifact } = require('./scripts/harvest');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  for (const [kind, fixture] of [
    ['review-recurring', '.../deep-review/tests/fixtures/sample-recurring-findings.json'],
    ['evolve-insights', '.../deep-evolve/tests/fixtures/sample-evolve-insights.json'],
    ['work-receipt', '.../deep-work/tests/fixtures/sample-session-receipt.json'],
    ['docs-scan', '.../deep-docs/tests/fixtures/sample-last-scan.json'],
  ]) { /* harvest + assert cards.length >= 1 */ }
  "

목표: 5개 sibling shape 전체에 대해 합계 ≥4 cards (deep-evolve의 sample이 빈 insights라면 그건 sibling 측 fixture 한계 — 별도 fixture 작성).

## Decision gates (mid-stream check)
- mapWorkReceipt Option A vs B 결정 (handoff-doc에서 A 추천)
- mapEvolveInsights에서 insights_for_deep_work vs insights_for_deep_review 통합 방식
- spec §7.1 in-place rewrite vs sibling-shape-contract.md 신설

시작해줘.
```

---

## Track T2 — v0.1.1 graceful FTS5 degradation prompt

(개별 진행 시) 또는 T1과 묶을 경우 위 T1 prompt에 다음 추가:

```
## (T2 — v0.1.1 better-sqlite3 graceful degradation, T1과 같은 release로 묶음)

### A. scripts/harvest.js degraded mode
- require fts-index를 try/catch 다시 도입 (round 5 ITEM-4 reverse).
- fts === null이면:
  * cards/events 정상 disk write
  * FTS5 upsert skip
  * 명시적 warning: "FTS5 lexical index unavailable (better-sqlite3 not loadable
    in this Node version). harvest continues but /deep-memory-brief will return
    empty results. See README.md > Troubleshooting."
- tests/harvest-fts-silent-disable.test.js 갱신: silent하지 않고 explicit warning이
  result.warnings에 들어가는지 검증.

### B. scripts/brief.js + scripts/retrieve.js graceful
- fts-index 모듈 require failure 시 graceful return — round 4의 "no lexical index"
  warning 경로 재사용.

### C. README.md + README.ko.md Troubleshooting 섹션 확장
- "Node 22 LTS recommended"
- Node 23+ workaround: nvm use 22 OR set DEEP_MEMORY_ROOT to writable path

### D. CHANGELOG entries
- ### Fixed: Node v26+ first-use blocker — FTS5 unavailable now degrades gracefully
  (harvest write OK, brief returns empty + warning) instead of hard-throwing.
```

---

## Track T3 — deep-work consumer integration prompt

(T1 + T2 완료 후) 별도 세션을 `/Users/sungmin/Dev/claude-plugins/deep-work/`에서 열고:

이전에 드린 [deep-work 시작 프롬프트](#) 를 그대로 사용하되, 다음 한 줄 추가:

> **Prerequisite**: deep-memory v0.1.2+ (mapper shape aligned + graceful FTS5 degradation) 가 published 상태여야 함. 그 전엔 `latest-brief.md`가 항상 빈 결과라 인용 가치 없음.

## Sanity checks before starting any track

```bash
cd /Users/sungmin/Dev/claude-plugins/deep-memory
git log --oneline | head -3                                    # last commit
npm test 2>&1 | tail -5                                        # 244 PASS
ls /Users/sungmin/Dev/claude-plugins/deep-{review,evolve,work,docs,wiki}/tests/fixtures/ 2>&1
# sibling fixture 존재 확인
```

## Open questions deferred to user

1. **Release versioning**: T1은 spec §7.1 mapper rule을 재작성하므로 breaking change. v0.1.2 (semver patch + breaking note) vs v0.2.0 (semver minor) — 사용자 결정.
2. **mapWorkReceipt Option A vs B**: handoff-doc은 A 추천 (single session-receipt → 1 card). B는 slice-receipt 단위 (더 세밀하지만 sources/path 변경).
3. **mapEvolveInsights**: deep-evolve의 `insights_for_deep_work` + `insights_for_deep_review` 두 키. 두 array union 또는 deep_work만 사용. spec 결정 필요.
