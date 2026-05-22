'use strict';
// tests/g-alpha-latency.test.js
// α.13 — G-α-latency gate per spec §3.2.2 + R2-N fixture specification.
// 30 sequential PostToolUse fires from a recorded session fixture; p95 ≤ 400 ms
// (= 500 ms budget − 20% headroom). Gated behind LATENCY=1 env flag so it
// only runs when explicitly invoked (CI matrix sets LATENCY=1; default
// `npm test` skips this gate for normal contributor flow).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('G-α-latency: 30 PostToolUse fires p95 ≤ 400 ms (R2-N)', { skip: !process.env.LATENCY }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-galpha-'));
  fs.writeFileSync(path.join(tmpRoot, 'config.yaml'), 'capture:\n  enabled: true\n');
  const fixtureLines = fs.readFileSync('tests/fixtures/hooks/g-alpha-macro.jsonl', 'utf8')
    .trim().split('\n');
  assert.strictEqual(fixtureLines.length, 30, 'fixture must have 30 events');

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
    assert.strictEqual(r.status, 0, `hook should exit 0; stderr=${r.stderr}`);
    durations.push(Number(t1 - t0) / 1_000_000);  // ns → ms
  }

  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const max = durations[durations.length - 1];
  console.log(`G-α latency — p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  assert.ok(
    p95 <= 400,
    `G-α p95 = ${p95.toFixed(1)} ms > 400 ms — redesign hook flow (async buffer + flush) per §3.2.2 G-α fallback`
  );

  // Sanity check: all 30 events were actually appended to events.jsonl.
  const monthFile = path.join(tmpRoot, 'events', new Date().toISOString().slice(0, 7) + '.jsonl');
  const eventLines = fs.readFileSync(monthFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(eventLines.length, 30, `expected 30 events written, got ${eventLines.length}`);
});

test('G-α-latency: fixture has correct R2-N size distribution', () => {
  const lines = fs.readFileSync('tests/fixtures/hooks/g-alpha-macro.jsonl', 'utf8')
    .trim().split('\n');
  assert.strictEqual(lines.length, 30);
  let largeCount = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.tool_output.length >= 8000) largeCount += 1;
  }
  // R2-N spec: 6 of 30 events are p95-sized (8192 chars) — 1 in 5 cadence.
  assert.strictEqual(largeCount, 6, `expected 6 large-output events (p95 cadence), got ${largeCount}`);
});
