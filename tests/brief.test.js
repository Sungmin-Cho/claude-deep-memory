'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openIndex, upsertCard, closeIndex } = require('../scripts/lib/fts-index');
const { run, resolveMemoryRoot, loadProjectProfile } = require('../scripts/brief');

function setup() {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm brief memory Ω '));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm brief project Ω '));
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(memoryRoot, sub), { recursive: true });
  }
  return {
    memoryRoot,
    projectDir,
    cleanup: () => {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

function plantGlobalCard(memoryRoot, payload, envelopeExtra = {}) {
  const dir = path.join(memoryRoot, 'cards', payload.memory_type, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const wrapped = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: '0.1.0',
      artifact_kind: 'memory-card',
      run_id: 'run_' + payload.memory_id,
      generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ id: 'src_0', path: 'fixtures/' + payload.memory_id + '.json' }], tool_versions: {} },
      ...envelopeExtra,
    },
    payload,
  };
  fs.writeFileSync(path.join(dir, payload.memory_id + '.json'), JSON.stringify(wrapped, null, 2));
  const idx = openIndex(path.join(memoryRoot, 'indexes', 'v2', 'lexical.sqlite'));
  try {
    upsertCard(idx, wrapped, { projectId: '' });
  } finally {
    closeIndex(idx);
  }
}

test('brief.run writes JSON + MD atomically to .deep-memory/', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    plantGlobalCard(memoryRoot, {
      memory_id: 'mem_test',
      memory_type: 'failure-case',
      privacy_level: 'global',
      claim: 'Codex skill discovery silently fails',
      tags: ['codex', 'skill'],
      applicability: [],
      non_applicability: [],
      recommended_action: ['Run manifest-drift CI'],
      search_keywords: ['codex'],
      evidence_summary: ['ev'],
      confidence: 0.7,
      status: 'candidate',
      dedupe_key: 'sha256:test',
    });
    const r = await run({
      task: 'codex skill discovery',
      projectDir,
      memoryRoot,
    });
    assert.strictEqual(r.count, 1);
    assert.ok(fs.existsSync(r.jsonPath));
    assert.ok(fs.existsSync(r.mdPath));
    const brief = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
    assert.strictEqual(brief.envelope.artifact_kind, 'memory-brief');
    assert.strictEqual(brief.payload.task, 'codex skill discovery');
    assert.strictEqual(brief.payload.memories[0].memory_id, 'mem_test');
    const md = fs.readFileSync(r.mdPath, 'utf8');
    assert.match(md, /Deep-Memory Brief — codex skill discovery/);
    assert.match(md, /mem_test/);

    const second = await run({
      task: 'codex skill discovery',
      projectDir,
      memoryRoot,
    });
    assert.strictEqual(second.jsonPath, r.jsonPath);
    assert.strictEqual(second.mdPath, r.mdPath);
    assert.deepStrictEqual(
      fs.readdirSync(path.dirname(r.jsonPath)).sort(),
      ['latest-brief.json', 'latest-brief.md'],
      'a second brief publish must leave no temporary files',
    );
  } finally {
    cleanup();
  }
});

test('brief.run with no profile: still produces a brief, warnings include missing profile', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    plantGlobalCard(memoryRoot, {
      memory_id: 'mem_x',
      memory_type: 'pattern',
      privacy_level: 'global',
      claim: 'codex pattern',
      tags: ['codex'],
      applicability: [],
      non_applicability: [],
      recommended_action: [],
      search_keywords: [],
      evidence_summary: ['ev'],
      confidence: 0.5,
      status: 'candidate',
      dedupe_key: 'sha256:nox',
    });
    const r = await run({ task: 'codex', projectDir, memoryRoot });
    assert.ok(r.warnings.some((w) => w.includes('missing project-profile')));
    const brief = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
    assert.ok(brief.payload.warnings.some((w) => w.includes('missing project-profile')));
  } finally {
    cleanup();
  }
});

test('brief.run with zero harvest (no index): empty brief + "no lexical index" warning', async () => {
  const { memoryRoot, projectDir, cleanup } = setup();
  try {
    const r = await run({ task: 'codex', projectDir, memoryRoot });
    assert.strictEqual(r.count, 0);
    assert.ok(r.warnings.some((w) => w.includes('no lexical index')));
    const md = fs.readFileSync(r.mdPath, 'utf8');
    assert.match(md, /No memories yet/);
  } finally {
    cleanup();
  }
});

test('brief.run requires task', async () => {
  await assert.rejects(() => run({}), /requires task/);
});

test('resolveMemoryRoot honors DEEP_MEMORY_ROOT env and ~ prefix', () => {
  const orig = process.env.DEEP_MEMORY_ROOT;
  try {
    delete process.env.DEEP_MEMORY_ROOT;
    assert.strictEqual(resolveMemoryRoot('~/foo'), path.join(os.homedir(), 'foo'));
    process.env.DEEP_MEMORY_ROOT = '/tmp/env-brief';
    assert.strictEqual(resolveMemoryRoot(), '/tmp/env-brief');
  } finally {
    if (orig === undefined) delete process.env.DEEP_MEMORY_ROOT;
    else process.env.DEEP_MEMORY_ROOT = orig;
  }
});

test('loadProjectProfile returns null for missing file (graceful)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm no profile Ω '));
  try {
    assert.strictEqual(loadProjectProfile(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
