'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { harvestArtifact } = require('../scripts/harvest');
const {
  applyAutoTransitions,
  detectDedupeCollisions,
  detectSourceRenames,
  promoteCard,
  run,
  validateAllCards,
} = require('../scripts/audit');
const { writeValidProjectProfile } = require('./helpers/project-profile-fixtures');

const PROJECT_ID = 'proj_aaaaaaaaaaaa';

function fixture(t, prefix) {
  const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function memoryRootWithExternalCardsAlias(t, prefix) {
  const root = fixture(t, `${prefix}-root-`);
  const outside = fixture(t, `${prefix}-outside-`);
  for (const sub of ['events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  try {
    fs.symlinkSync(outside, path.join(root, 'cards'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      return { available: false, reason: 'junction_fixture_unavailable' };
    }
    throw error;
  }
  return { available: true, root, outside };
}

function wrappedCard(memoryId, { privacy = 'local', stale = false } = {}) {
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory', producer_version: '1.0.2', artifact_kind: 'memory-card',
      run_id: `run_${memoryId}`, generated_at: new Date().toISOString(),
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: 'fixture/source.json' }], tool_versions: {} },
    },
    payload: {
      memory_id: memoryId, memory_type: 'pattern', privacy_level: privacy,
      claim: 'external card must never be mutated', status: 'validated', status_history: [],
      review_after: new Date(Date.now() + (stale ? -1 : 1) * 86400 * 1000).toISOString(),
      evidence_summary: ['fixture'], applicability: [], non_applicability: [],
      recommended_action: [], search_keywords: [], tags: [], confidence: 0.8,
      dedupe_key: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function plantOutside(outside, memoryId, options) {
  const scope = options && options.privacy === 'global' ? 'global' : PROJECT_ID;
  const file = path.join(outside, 'pattern', scope, `${memoryId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(wrappedCard(memoryId, options), null, 2));
  return file;
}

function containedMemoryRoot(t, prefix) {
  const root = fixture(t, prefix);
  for (const sub of ['cards', 'events', 'indexes', 'projects', '.leases']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function completeCard(memoryId, {
  privacy = 'global', status = 'candidate', stale = false, claim = 'contained audit fixture',
} = {}) {
  const createdAt = '2026-01-01T00:00:00.000Z';
  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory', producer_version: '1.0.2', artifact_kind: 'memory-card',
      run_id: `run_${memoryId}`, generated_at: createdAt,
      schema: { name: 'memory-card', version: '1.0' },
      provenance: { source_artifacts: [{ path: 'fixture/source.json' }], tool_versions: {} },
    },
    payload: {
      memory_id: memoryId, memory_type: 'pattern', privacy_level: privacy,
      title: 'Contained audit fixture', claim, status, status_history: [],
      review_after: stale ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
      evidence_summary: ['fixture'], applicability: [], non_applicability: [],
      recommended_action: [], search_keywords: [], tags: [], confidence: 0.8,
      dedupe_key: `sha256:${'a'.repeat(64)}`,
      created_at: createdAt, last_seen_at: createdAt,
      feedback: { accepted_count: 0, rejected_count: 0, inaccurate_count: 0 },
      deep_memory_provenance: [],
    },
  };
}

function writeCard(root, type, scope, file, card) {
  const target = path.join(root, 'cards', type, scope, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(card));
  return target;
}

function writeFiveThousandGlobalFillers(root) {
  const directory = path.join(root, 'cards', 'bbb', 'global');
  fs.mkdirSync(directory, { recursive: true });
  const bytes = JSON.stringify(completeCard('mem_filler_deadbeef'));
  for (let index = 0; index < 5000; index += 1) {
    fs.writeFileSync(path.join(directory, `${String(index).padStart(5, '0')}.json`), bytes);
  }
}

function createAliasFixture(t, target, alias, kind) {
  try {
    fs.symlinkSync(target, alias, process.platform === 'win32' && kind === 'dir' ? 'junction' : kind);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error && error.code)) {
      t.skip('junction_fixture_unavailable');
      return false;
    }
    throw error;
  }
}

function captureAuditCall(call) {
  try {
    call();
    return { code: null, warning: null, returned: true };
  } catch (error) {
    return { code: error && error.code, warning: error && error.warning, returned: false };
  }
}

function auditFailureSnapshot(root, earlyPath, earlyBytes) {
  return {
    schema: captureAuditCall(() => validateAllCards(root, { projectId: PROJECT_ID })),
    dedupe: captureAuditCall(() => detectDedupeCollisions(root, { projectId: PROJECT_ID })),
    sourceRenames: captureAuditCall(() => detectSourceRenames(root, { projectId: PROJECT_ID })),
    transitions: captureAuditCall(() => applyAutoTransitions(root, { projectId: PROJECT_ID })),
    earlyUnchanged: fs.readFileSync(earlyPath).equals(earlyBytes),
  };
}

function expectedAuditFailure(warning) {
  const failure = () => ({ code: 'CARD_PATH_UNSAFE', warning, returned: false });
  return {
    schema: failure(),
    dedupe: failure(),
    sourceRenames: failure(),
    transitions: failure(),
    earlyUnchanged: true,
  };
}

function earlyAuditCard(t, prefix) {
  const root = containedMemoryRoot(t, prefix);
  const earlyPath = writeCard(
    root,
    'aaa',
    'global',
    '00000-early.json',
    completeCard('mem_early_deadbeef', { status: 'validated', stale: true }),
  );
  return { root, earlyPath, earlyBytes: fs.readFileSync(earlyPath) };
}

test('harvest rejects a cards symlink/junction before any external write', async (t) => {
  const aliased = memoryRootWithExternalCardsAlias(t, 'dm-harvest-mutation');
  if (!aliased.available) return t.skip(aliased.reason);
  const artifactPath = path.join(__dirname, 'fixtures', 'sample-recurring-findings.json');
  await assert.rejects(
    () => harvestArtifact({
      artifactPath, sourceKind: 'review-recurring', memoryRoot: aliased.root,
      projectId: PROJECT_ID, skipDistillStepB: true,
    }),
    (error) => error && error.code === 'CARD_PATH_UNSAFE',
  );
  assert.deepEqual(fs.readdirSync(aliased.outside), [], 'harvest must not write through cards alias');
});

test('audit transition refuses a cards symlink/junction and preserves external bytes', (t) => {
  const aliased = memoryRootWithExternalCardsAlias(t, 'dm-audit-mutation');
  if (!aliased.available) return t.skip(aliased.reason);
  const external = plantOutside(aliased.outside, 'mem_stale_external', { stale: true });
  const before = fs.readFileSync(external);
  assert.throws(
    () => applyAutoTransitions(aliased.root, { projectId: PROJECT_ID }),
    (error) => error && error.code === 'CARD_PATH_UNSAFE' && error.warning === 'card_path_link_rejected',
  );
  assert.deepEqual(fs.readFileSync(external), before);
});

test('promotion refuses external read/write/unlink through a cards alias', async (t) => {
  const aliased = memoryRootWithExternalCardsAlias(t, 'dm-promote-mutation');
  if (!aliased.available) return t.skip(aliased.reason);
  const external = plantOutside(aliased.outside, 'mem_promote_external');
  const before = fs.readFileSync(external);
  await assert.rejects(
    () => promoteCard('mem_promote_external', { memoryRoot: aliased.root, projectId: PROJECT_ID }),
    (error) => error && error.code === 'CARD_PATH_UNSAFE',
  );
  assert.deepEqual(fs.readFileSync(external), before);
  assert.equal(fs.existsSync(path.join(aliased.outside, 'pattern', 'global', 'mem_promote_external.json')), false);
});

test('audit validates and transitions every eligible card beyond the bounded retrieval fallback', (t) => {
  const root = containedMemoryRoot(t, 'dm-audit-exhaustive-');
  writeFiveThousandGlobalFillers(root);
  writeCard(root, 'zzz', 'global', '00000-invalid.json', {
    schema_version: '1.0', envelope: { producer: 'deep-memory' },
  });
  const latePath = writeCard(
    root,
    'zzz',
    'global',
    '99999-stale.json',
    completeCard('mem_late_deadbeef', { status: 'validated', stale: true }),
  );

  const schema = validateAllCards(root, { projectId: PROJECT_ID });
  const transitions = applyAutoTransitions(root, { projectId: PROJECT_ID });
  const lateCard = JSON.parse(fs.readFileSync(latePath, 'utf8'));

  assert.deepEqual({
    schema: {
      total: schema.total,
      valid: schema.valid,
      invalid: schema.invalid,
      violationIds: schema.schema_violations.map((item) => item.memory_id),
    },
    transitions: {
      total: transitions.total,
      transitioned: transitions.transitioned,
      memoryIds: transitions.transitions.map((item) => item.memory_id),
    },
    lateStatus: lateCard.payload.status,
  }, {
    schema: { total: 5002, valid: 5001, invalid: 1, violationIds: [null] },
    transitions: { total: 5002, transitioned: 1, memoryIds: ['mem_late_deadbeef'] },
    lateStatus: 'deprecated',
  });
});

test('promotion beyond 5000 eligible cards fails closed and preserves both authoritative copies', async (t) => {
  const root = containedMemoryRoot(t, 'dm-promote-exhaustive-');
  const memoryId = 'mem_target_deadbeef';
  const localPath = writeCard(
    root,
    'aaa',
    PROJECT_ID,
    `${memoryId}.json`,
    completeCard(memoryId, { privacy: 'local', claim: 'local bytes must survive' }),
  );
  writeFiveThousandGlobalFillers(root);
  const existingGlobalPath = writeCard(
    root,
    'zzz',
    'global',
    `${memoryId}.json`,
    completeCard(memoryId, { claim: 'authoritative global bytes must survive' }),
  );
  const newGlobalPath = path.join(root, 'cards', 'aaa', 'global', `${memoryId}.json`);
  const localBefore = fs.readFileSync(localPath, 'utf8');
  const globalBefore = fs.readFileSync(existingGlobalPath, 'utf8');

  let error = null;
  let result = null;
  try {
    result = await promoteCard(memoryId, { memoryRoot: root, projectId: PROJECT_ID });
  } catch (caught) {
    error = caught;
  }

  assert.deepEqual({
    errorCode: error && error.code,
    resultId: result && result.memory_id,
    localBytes: fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : null,
    existingGlobalBytes: fs.readFileSync(existingGlobalPath, 'utf8'),
    newGlobalExists: fs.existsSync(newGlobalPath),
    globalCopies: [newGlobalPath, existingGlobalPath].filter((file) => fs.existsSync(file)).length,
  }, {
    errorCode: 'ALREADY_GLOBAL',
    resultId: null,
    localBytes: localBefore,
    existingGlobalBytes: globalBefore,
    newGlobalExists: false,
    globalCopies: 1,
  });
});

test('every exhaustive audit consumer fails closed before mutation on a late unsafe or unreadable card', async (t) => {
  await t.test('late type symlink or junction', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-type-link-');
    const outside = fixture(child, 'dm-audit-late-type-outside-');
    writeCard(outside, 'ignored', 'global', 'late.json', completeCard('mem_late_deadbeef'));
    if (!createAliasFixture(child, path.join(outside, 'cards', 'ignored'), path.join(fixtureRoot.root, 'cards', 'zzz'), 'dir')) return;
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_link_rejected'),
    );
  });

  await t.test('late scope symlink or junction', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-scope-link-');
    const outside = fixture(child, 'dm-audit-late-scope-outside-');
    const outsideScope = path.join(outside, 'global');
    fs.mkdirSync(outsideScope, { recursive: true });
    fs.writeFileSync(path.join(outsideScope, 'late.json'), JSON.stringify(completeCard('mem_late_deadbeef')));
    fs.mkdirSync(path.join(fixtureRoot.root, 'cards', 'zzz'), { recursive: true });
    if (!createAliasFixture(child, outsideScope, path.join(fixtureRoot.root, 'cards', 'zzz', 'global'), 'dir')) return;
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_link_rejected'),
    );
  });

  await t.test('late file symlink', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-file-link-');
    const outside = fixture(child, 'dm-audit-late-file-outside-');
    const outsideFile = path.join(outside, 'late.json');
    fs.writeFileSync(outsideFile, JSON.stringify(completeCard('mem_late_deadbeef')));
    const lateFile = path.join(fixtureRoot.root, 'cards', 'zzz', 'global', 'late.json');
    fs.mkdirSync(path.dirname(lateFile), { recursive: true });
    if (!createAliasFixture(child, outsideFile, lateFile, 'file')) return;
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_link_rejected'),
    );
  });

  await t.test('late file physical escape', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-physical-');
    const lateFile = writeCard(
      fixtureRoot.root, 'zzz', 'global', 'late.json', completeCard('mem_late_deadbeef'),
    );
    const outside = fixture(child, 'dm-audit-late-physical-outside-');
    const outsideFile = path.join(outside, 'late.json');
    fs.writeFileSync(outsideFile, JSON.stringify(completeCard('mem_outside_deadbeef')));
    const realpathNative = fs.realpathSync.native;
    child.mock.method(fs.realpathSync, 'native', (value, ...args) => (
      path.resolve(value) === path.resolve(lateFile)
        ? outsideFile
        : Reflect.apply(realpathNative, fs.realpathSync, [value, ...args])
    ));
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_outside_scope'),
    );
  });

  await t.test('late directory listing EIO', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-list-eio-');
    const lateFile = writeCard(
      fixtureRoot.root, 'zzz', 'global', 'late.json', completeCard('mem_late_deadbeef'),
    );
    const lateDirectory = path.dirname(lateFile);
    const readdirSync = fs.readdirSync;
    child.mock.method(fs, 'readdirSync', (value, ...args) => {
      if (path.resolve(value) === path.resolve(lateDirectory)) {
        throw Object.assign(new Error('injected late listing failure'), { code: 'EIO' });
      }
      return Reflect.apply(readdirSync, fs, [value, ...args]);
    });
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_unavailable'),
    );
  });

  await t.test('late card read EIO', (child) => {
    const fixtureRoot = earlyAuditCard(child, 'dm-audit-late-read-eio-');
    const lateFile = writeCard(
      fixtureRoot.root, 'zzz', 'global', 'late.json', completeCard('mem_late_deadbeef'),
    );
    const readFileSync = fs.readFileSync;
    child.mock.method(fs, 'readFileSync', (value, ...args) => {
      if (path.resolve(value) === path.resolve(lateFile)) {
        throw Object.assign(new Error('injected late read failure'), { code: 'EIO' });
      }
      return Reflect.apply(readFileSync, fs, [value, ...args]);
    });
    assert.deepEqual(
      auditFailureSnapshot(fixtureRoot.root, fixtureRoot.earlyPath, fixtureRoot.earlyBytes),
      expectedAuditFailure('card_path_unavailable'),
    );
  });
});

test('top-level audit propagates a late transition read failure without publishing or mutating', async (t) => {
  const fixtureRoot = earlyAuditCard(t, 'dm-audit-run-late-read-eio-');
  const lateFile = writeCard(
    fixtureRoot.root, 'zzz', 'global', 'late.json', completeCard('mem_late_deadbeef'),
  );
  const projectDir = fixture(t, 'dm-audit-run-project-');
  writeValidProjectProfile(projectDir);
  const reportPath = path.join(projectDir, '.deep-memory', 'latest-audit.json');
  const lateBytes = fs.readFileSync(lateFile);
  let lateReads = 0;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (value, ...args) => {
    if (typeof value === 'string' && path.resolve(value) === path.resolve(lateFile)) {
      lateReads += 1;
      if (lateReads === 4) {
        throw Object.assign(new Error('injected transition preflight read failure'), { code: 'EIO' });
      }
    }
    return Reflect.apply(readFileSync, fs, [value, ...args]);
  });

  await assert.rejects(
    () => run({ memoryRoot: fixtureRoot.root, projectDir }),
    (error) => error && error.code === 'CARD_PATH_UNSAFE'
      && error.warning === 'card_path_unavailable',
  );
  assert.equal(lateReads, 4, 'fault must occur only in the transition preflight pass');
  assert.equal(fs.existsSync(reportPath), false, 'failed audit must not publish latest-audit.json');
  assert.deepEqual(fs.readFileSync(fixtureRoot.earlyPath), fixtureRoot.earlyBytes);
  assert.deepEqual(fs.readFileSync(lateFile), lateBytes);
});

test('promotion rejects an unreadable late duplicate before any global write or local unlink', async (t) => {
  const root = containedMemoryRoot(t, 'dm-promote-late-duplicate-eio-');
  const memoryId = 'mem_target_deadbeef';
  const targetPath = writeCard(
    root, 'aaa', PROJECT_ID, `${memoryId}.json`,
    completeCard(memoryId, { privacy: 'local', claim: 'early target must survive' }),
  );
  const globalInputPath = writeCard(
    root, 'bbb', 'global', 'unrelated.json',
    completeCard('mem_global_deadbeef', { claim: 'global input must survive' }),
  );
  const duplicatePath = writeCard(
    root, 'zzz', PROJECT_ID, 'late-duplicate.json',
    completeCard(memoryId, { privacy: 'local', claim: 'unreadable duplicate must survive' }),
  );
  const outputPath = path.join(root, 'cards', 'aaa', 'global', `${memoryId}.json`);
  const before = new Map([
    [targetPath, fs.readFileSync(targetPath)],
    [globalInputPath, fs.readFileSync(globalInputPath)],
    [duplicatePath, fs.readFileSync(duplicatePath)],
  ]);
  let duplicateReads = 0;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (value, ...args) => {
    if (typeof value === 'string' && path.resolve(value) === path.resolve(duplicatePath)) {
      duplicateReads += 1;
      if (duplicateReads === 1) {
        throw Object.assign(new Error('injected duplicate read failure'), { code: 'EIO' });
      }
    }
    return Reflect.apply(readFileSync, fs, [value, ...args]);
  });

  await assert.rejects(
    () => promoteCard(memoryId, { memoryRoot: root, projectId: PROJECT_ID }),
    (error) => error && error.code === 'CARD_PATH_UNSAFE'
      && error.warning === 'card_path_unavailable',
  );
  assert.equal(duplicateReads, 1);
  assert.equal(fs.existsSync(outputPath), false, 'promotion must not create a global target');
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
});
