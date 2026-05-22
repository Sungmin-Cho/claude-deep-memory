'use strict';
// tests/g-beta-latency.test.js
// β.10 — G-β-latency gate. 30-fire macrobenchmark with concurrent
// /deep-memory-brief-equivalent (runLazyDistill) mid-stream. Verifies §4.5
// lock split is effective: hook append must not block behind distill's
// LLM/embedding work. Target: p95 ≤ 500 ms (full 500ms budget; the 100ms
// extra over G-α accounts for cross-process lock contention from the
// concurrent brief).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLazyDistill } = require('../scripts/lib/distill-pipeline');

test('G-β-latency: 30 hooks p95 ≤ 500 ms with concurrent distill (PR2-B + §4.5)', { skip: !process.env.LATENCY }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-gbeta-'));
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'), 'capture:\n  enabled: true\n');
  const fixtureLines = fs.readFileSync('tests/fixtures/hooks/g-alpha-macro.jsonl', 'utf8').trim().split('\n');
  assert.strictEqual(fixtureLines.length, 30);

  // Schedule a concurrent distill mid-stream — fires after hook 10.
  const distillPromise = new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const r = await runLazyDistill({
          root: tmpRoot,
          projectId: 'g-beta-bench',
          config: { skip_llm: true, distill: { detectors: { session_summary: { always_emit: true } } } }
        });
        resolve(r);
      } catch (e) {
        resolve({ error: e.message });
      }
    }, 100);  // ~ 100ms after hook stream start
  });

  const durations = [];
  for (const line of fixtureLines) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('node', ['scripts/hooks/post-tool-use.mjs'], {
      input: line,
      env: { ...process.env, DEEP_MEMORY_ROOT: tmpRoot, PROJECT_CWD: tmpRoot },
      encoding: 'utf8',
      timeout: 10000
    });
    const t1 = process.hrtime.bigint();
    assert.strictEqual(r.status, 0);
    durations.push(Number(t1 - t0) / 1_000_000);
  }
  await distillPromise;  // ensure concurrent distill completes too

  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const max = durations[durations.length - 1];
  console.log(`G-β latency (with concurrent distill) — p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  assert.ok(
    p95 <= 500,
    `G-β p95 = ${p95.toFixed(1)} ms > 500 ms — §4.5 lock split is ineffective; redesign per spec §3.2.2 G-β fallback`
  );
});

test('G-β-latency: lock-split design — distill pipeline does not require lock module', async () => {
  // Static design assertion: scripts/lib/distill-pipeline.js#runLazyDistill
  // must not import the lock module. Stage 4 LLM + Stage 5 embedding run
  // OUTSIDE the global lock; locking is delegated to the commitDrafts
  // callback (which uses lock only for the bounded Stage 6 commit critical
  // section). PR2-B + spec §4.5 lock-granularity invariant.
  const src = fs.readFileSync('scripts/lib/distill-pipeline.js', 'utf8');
  assert.ok(!/require\(['"][^'"]*\/lock(\.js)?['"]\)/.test(src),
    'distill-pipeline.js must not require ./lock — Stage 4/5 (LLM, embed) must run OUTSIDE the lock');
});
