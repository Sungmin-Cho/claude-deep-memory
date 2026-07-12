'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAgentContractPath } = require('../scripts/lib/host-mediated-dispatch');

const root = path.resolve(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills/deep-memory-harvest/SKILL.md'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'agents/memory-distiller.md'), 'utf8');

test('harvest routes Claude Code to the named memory-distiller agent', () => {
  assert.match(skill, /Step B host dispatch/i);
  assert.match(skill, /Claude Code[\s\S]*named[^\n]*`?memory-distiller`?/i);
  assert.match(skill, /deep-memory-host-distill-v1/);
});

test('Codex generic subagent reads the authoritative agent file first', () => {
  assert.match(skill, /Codex[\s\S]*generic subagent/i);
  assert.match(skill, /first action[\s\S]*agents\/memory-distiller\.md/i);
  assert.match(skill, /Read[^\n]*Glob[^\n]*Grep[^\n]*(?:only|no write)/i);
  assert.match(skill, /JSON only/i);
});

test('other hosts and all host output retain explicit validated fallback semantics', () => {
  assert.match(skill, /Gemini[\s\S]*stdin[\s\S]*fallback/i);
  assert.match(skill, /Ajv[\s\S]*(?:invalid|timeout)[\s\S]*candidate fallback/i);
  assert.match(skill, /executable process spec/i);
});

test('agent prompt remains single-source rather than copied into the skill', () => {
  const hardConstraintParagraph = agent.match(/## Hard constraints[\s\S]*?## Output format/)[0];
  assert.equal(skill.includes(hardConstraintParagraph), false);
  assert.equal((skill.match(/claim_refined/g) || []).length, 0);
});

test('authoritative agent path resolves from both source and bundled entry layouts', (t) => {
  assert.equal(resolveAgentContractPath(path.join(root, 'scripts', 'lib')),
    path.join(root, 'agents', 'memory-distiller.md'));

  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-bundled-agent-root-'));
  const plugin = path.join(container, 'plugin');
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'agents', 'memory-distiller.md'), 'authoritative');
  fs.mkdirSync(path.join(container, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(container, 'agents', 'memory-distiller.md'), 'foreign parent contract');
  assert.equal(resolveAgentContractPath(path.join(plugin, 'dist')),
    path.join(plugin, 'agents', 'memory-distiller.md'));
});
