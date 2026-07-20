'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));

const maintainedDocs = [
  'README.md', 'README.ko.md', 'CHANGELOG.md', 'CHANGELOG.ko.md',
  'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md',
];

function headingSequence(text) {
  return [...text.matchAll(/^## \[([^\]]+)\] [\u2014-] (\d{4}-\d{2}-\d{2})$|^### ([A-Za-z]+)/gm)]
    .map((match) => match[1] ? `release:${match[1]}:${match[2]}` : `category:${match[3]}`);
}

test('all release version sources and the root lockfile are 1.0.3', () => {
  for (const name of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    assert.equal(json(name).version, '1.0.3', name);
  }
  assert.equal(json('package-lock.json').version, '1.0.3');
  assert.equal(json('package-lock.json').packages[''].version, '1.0.3');
  assert.doesNotMatch(json('package.json').description, /tests \+ helpers only/i);
});

test('CI is one uniform Node 22 pwsh matrix across Ubuntu macOS and Windows', () => {
  const workflowText = read('.github/workflows/ci.yml');
  const workflow = yaml.load(workflowText);
  assert.equal(workflow.defaults?.run?.shell, 'pwsh');
  assert.deepEqual(workflow.jobs?.test?.strategy?.matrix?.os, [
    'ubuntu-latest', 'macos-latest', 'windows-latest',
  ]);
  assert.equal(workflow.jobs?.test?.runsOn || workflow.jobs?.test?.['runs-on'], '${{ matrix.os }}');
  assert.equal(workflow.jobs?.test?.['timeout-minutes'], 10, 'CI must bound retained-handle failures');

  const steps = workflow.jobs?.test?.steps || [];
  assert.equal(steps.some((step) => Object.hasOwn(step, 'shell')), false, 'per-step shell override');
  const setup = steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.equal(setup?.with?.['node-version'], 22);
  assert.equal(setup?.with?.cache, 'npm');
  const runs = steps.filter((step) => typeof step.run === 'string').map((step) => step.run.trim());
  for (const required of [
    'npm ci --no-audit --no-fund',
    'npm run build:mcp',
    'git diff --exit-code -- dist/mcp-server.cjs',
    'npm run validate-manifest',
    'npm test',
  ]) assert.ok(runs.includes(required), `missing CI command: ${required}`);
  for (const run of runs) {
    assert.doesNotMatch(run, /(?:^|[;&|\s])(?:bash|sh|python\d*|pytest|jq|sed|grep|find|cp|rm)(?:\s|$)|\.sh(?:\s|$)/i);
  }
});

test('English and Korean README sections stay parallel and document native hosts', () => {
  const en = read('README.md');
  const ko = read('README.ko.md');
  const enHeadings = [...en.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const koHeadings = [...ko.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(enHeadings, [
    'Install', 'Quick start', 'Three-layer model', 'Skills', 'Privacy',
    'Cross-runtime', 'Support and recovery', 'Links', 'License',
  ]);
  assert.deepEqual(koHeadings, [
    '설치', '빠른 시작', '3계층 모델', '스킬', '프라이버시',
    '크로스 런타임', '지원 및 복구', '링크', '라이선스',
  ]);
  assert.match(en, /codex plugin add deep-memory@claude-deep-suite/);
  assert.match(ko, /codex plugin add deep-memory@claude-deep-suite/);
  for (const text of [en, ko]) {
    assert.match(text, /Node 22/);
    assert.match(text, /Windows 11/);
    assert.match(text, /macOS/);
    assert.match(text, /Linux/);
    assert.match(text, /FTS5/);
    assert.match(text, /bounded card-scan/i);
    assert.match(text, /Claude[^\n]*six|Claude[^\n]*6/i);
    assert.match(text, /Codex[^\n]*four|Codex[^\n]*4/i);
    assert.match(text, /capture[^\n]*OFF/i);
  }
});

test('all four bilingual release documents state loss-averse manual recovery', () => {
  const docs = Object.fromEntries(['README.md', 'README.ko.md', 'CHANGELOG.md', 'CHANGELOG.ko.md']
    .map((name) => [name, read(name)]));
  for (const name of ['README.md', 'CHANGELOG.md']) {
    assert.match(docs[name], /initialize every workspace/i, name);
    assert.match(docs[name], /harvest again/i, name);
    assert.match(docs[name], /not migrated automatically/i, name);
    assert.match(docs[name], /export(?:ed)? or back(?:ed)? up/i, name);
  }
  for (const name of ['README.ko.md', 'CHANGELOG.ko.md']) {
    assert.match(docs[name], /모든 워크스페이스[^\n]*초기화/, name);
    assert.match(docs[name], /다시[^\n]*하베스트|하베스트[^\n]*다시/, name);
    assert.match(docs[name], /자동[^\n]*마이그레이션[^\n]*않|자동[^\n]*이전[^\n]*않/, name);
    assert.match(docs[name], /내보내기|백업/, name);
  }
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /automatically (?:migrates?|re-?associates?|repairs?)|self[- ]heal/i, name);
  }
});

test('complete bilingual changelog histories are structurally parallel and process-noise free', () => {
  const en = read('CHANGELOG.md');
  const ko = read('CHANGELOG.ko.md');
  assert.match(en, /^## \[1\.0\.3\] \u2014 2026-07-20$/m);
  assert.match(ko, /^## \[1\.0\.3\] \u2014 2026-07-20$/m);
  assert.match(en, /^## \[1\.0\.2\] \u2014 2026-07-10$/m);
  assert.match(ko, /^## \[1\.0\.2\] \u2014 2026-07-10$/m);
  assert.deepEqual(headingSequence(en), headingSequence(ko));
  const releases = headingSequence(en).filter((entry) => entry.startsWith('release:'));
  assert.deepEqual(releases, [
    'release:1.0.3:2026-07-20',
    'release:1.0.2:2026-07-10', 'release:1.0.1:2026-07-09',
    'release:1.0.0:2026-07-09', 'release:0.4.0:2026-07-07',
    'release:0.3.2:2026-05-25', 'release:0.3.1:2026-05-22',
    'release:0.3.0:2026-05-22', 'release:0.1.3:2026-05-21',
    'release:0.1.2:2026-05-21', 'release:0.1.0:2026-05-20',
  ]);
  for (const [name, text] of [['CHANGELOG.md', en], ['CHANGELOG.ko.md', ko]]) {
    assert.doesNotMatch(text, /^### (?:Tests|Verification)\b/gmi, name);
    assert.doesNotMatch(text, /(?:\b\d+\s*\/\s*\d+\s*pass\b|npm test|deep-review|review[- ]loop|REQUEST_CHANGES|APPROVE|\b[A-F0-9]{7,40}\b|\bPR\s*#?\d+)/i, name);
  }
});

test('maintained docs are jq-free and agent guides use the portable version command', () => {
  for (const name of maintainedDocs) assert.doesNotMatch(read(name), /\bjq\b/i, name);
  assert.match(read('AGENTS.md'), /node -e "console\.log\(require\('\.\/\.codex-plugin\/plugin\.json'\)\.version\)"/);
  assert.match(read('CLAUDE.md'), /node -e "console\.log\(require\('\.\/\.claude-plugin\/plugin\.json'\)\.version\)"/);
});
