'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('init skill matches Node 22 and canonical physical root-only project identity', () => {
  const skill = read('skills/deep-memory-init/SKILL.md');
  assert.match(skill, /Node(?:\.js)?\s*22/i);
  assert.match(skill, /canonical physical root/i);
  assert.match(skill, /root-only/i);
  assert.doesNotMatch(skill, /Node(?:\.js)?\s*18/i);
  assert.doesNotMatch(skill, /sql\.js/i);
  assert.doesNotMatch(skill, /remote_url_hash|remote\s*url\s*hash/i);
});

test('init skill documents the actual filesystem and network preflight without a SQLite probe', () => {
  const skill = read('skills/deep-memory-init/SKILL.md');
  assert.match(skill, /realpath[\s\S]*writ|writ[\s\S]*realpath/i);
  assert.match(skill, /network (?:mount|root)|NFS|UNC/i);
  assert.match(skill, /native FTS5[\s\S]*(?:harvest|retriev)|(?:harvest|retriev)[\s\S]*native FTS5/i);
  assert.doesNotMatch(skill, /sqlite\s+(?:preflight\s+)?probe|SQLite preflight/i);
});

test('harvest and audit skills preserve the sealed legacy index and name only v2 recovery', () => {
  const harvest = read('skills/deep-memory-harvest/SKILL.md');
  const audit = read('skills/deep-memory-audit/SKILL.md');
  for (const skill of [harvest, audit]) {
    assert.match(skill, /indexes\/v2\/lexical\.sqlite/);
    assert.match(skill, /sealed legacy/i);
    assert.match(skill, /manual non-migrating recovery/i);
    assert.doesNotMatch(skill, /delete\s+`?~\/\.deep-memory\/indexes\/lexical\.sqlite/i);
    assert.doesNotMatch(skill, /--rebuild-index/);
  }
  assert.doesNotMatch(audit, /cross-scope|AMBIGUOUS|disambiguat/i);
  assert.match(audit, /validated current project scope/i);
});

test('brief skill documents global-only profile fallback and bounded privacy card scan', () => {
  const skill = read('skills/deep-memory-brief/SKILL.md');
  assert.match(skill, /profile.*missing.*global-only|missing.*profile.*global-only/is);
  assert.match(skill, /bounded privacy-scoped card scan/i);
  assert.doesNotMatch(skill, /profile.*missing.*(?:abort with|안내 후 abort)|missing.*profile.*(?:abort with|안내 후 abort)/is);
  assert.doesNotMatch(skill, /sql\.js/i);
  assert.doesNotMatch(skill, /brief.*\{\s*memories:\s*\[\].*better-sqlite3/is);
});

test('brief skill matches stale scoring, atomic Markdown publication, and both privacy paths', () => {
  const skill = read('skills/deep-memory-brief/SKILL.md');
  assert.match(skill, /Stage 1[\s\S]*status[^\n]*deprecated/i);
  assert.match(skill, /review_after[\s\S]*stale[^\n]*penalty|stale[^\n]*penalty[\s\S]*review_after/i);
  assert.doesNotMatch(skill, /Stage 1[^\n]*review_after[^\n]*(?:hard|drop|경과)/i);
  assert.match(skill, /writeTextAtomic/);
  assert.doesNotMatch(skill, /writeFileSync/);
  assert.match(skill, /FTS5[\s\S]*SQL[\s\S]*privacy/i);
  assert.match(skill, /card scan[\s\S]*(?:physical|contained|scope)/i);
  assert.doesNotMatch(skill, /privacy filter[^\n]*SQL[^\n]*(?:우회 불가|cannot be bypassed)/i);
});

test('active harvest warning describes the implemented bounded scan fallback', () => {
  const source = read('scripts/harvest.js');
  const warning = /const FTS_DEGRADED_WARNING =[\s\S]*?;/.exec(source)?.[0] || '';
  assert.match(warning, /bounded privacy-scoped card scan/i);
  assert.doesNotMatch(warning, /brief returns empty|future sql\.js|wait for.*sql\.js/i);
});
