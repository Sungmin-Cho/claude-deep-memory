// tests/manifest-drift.test.js
// R3 P19 fix: path.resolve(__dirname, '..') for project root — never absolute /Users/... paths.
// R3 P22 fix: js-yaml parse for SKILL.md frontmatter — regex doesn't handle multi-line / block scalar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const claudeManifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
const codexManifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const codexHooksPath = path.join(root, codexManifest.hooks || '');
const mcpManifest = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));

test('manifest-drift: version 3중 동기 (claude / codex / package.json)', () => {
  assert.strictEqual(claudeManifest.version, pkg.version, `claude=${claudeManifest.version} pkg=${pkg.version}`);
  assert.strictEqual(codexManifest.version, pkg.version, `codex=${codexManifest.version} pkg=${pkg.version}`);
});

test('manifest-drift: Codex descriptions ≤ 1024 chars (description + shortDescription + longDescription)', () => {
  assert.ok(codexManifest.description.length <= 1024,
    `codex description ${codexManifest.description.length} chars`);
  assert.ok(codexManifest.interface.shortDescription.length <= 1024,
    `codex shortDescription ${codexManifest.interface.shortDescription.length} chars`);
  assert.ok(codexManifest.interface.longDescription.length <= 1024,
    `codex longDescription ${codexManifest.interface.longDescription.length} chars`);
});

test('manifest-drift: all skill SKILL.md frontmatter — strict YAML + description ≤ 1024 chars (R3 P22)', () => {
  const skillsDir = path.join(root, 'skills');
  if (!fs.existsSync(skillsDir)) {
    // P25 mitigation: vacuous pass acceptable in Phase 1 (skills/ created in Phase 2).
    // Phase 6.1.a rerun gate will re-execute this test after Phase 2.
    return;
  }
  for (const skill of fs.readdirSync(skillsDir)) {
    const sf = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(sf)) continue;
    const txt = fs.readFileSync(sf, 'utf8');
    const fmMatch = txt.match(/^---\n([\s\S]+?)\n---/);
    assert.ok(fmMatch, `${skill}: no frontmatter`);
    let fm;
    try { fm = yaml.load(fmMatch[1]); }
    catch (e) { assert.fail(`${skill}: strict YAML parse error: ${e.message}`); }
    assert.ok(typeof fm.description === 'string' && fm.description.length > 0,
      `${skill}: missing description`);
    assert.ok(fm.description.length <= 1024,
      `${skill} description ${fm.description.length} chars (Codex limit)`);
  }
});

test('manifest-drift: claude manifest minimal fields present', () => {
  for (const field of ['name', 'version', 'description', 'author', 'license', 'keywords']) {
    assert.ok(claudeManifest[field] !== undefined, `claude manifest missing ${field}`);
  }
  assert.strictEqual(claudeManifest.name, 'deep-memory');
});

test('manifest-drift: codex manifest interface block present', () => {
  assert.ok(codexManifest.interface, 'codex manifest missing interface');
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'capabilities', 'defaultPrompt']) {
    assert.ok(codexManifest.interface[field] !== undefined, `codex interface missing ${field}`);
  }
});

test('manifest-drift: codex hooks use external hooks.json with Claude hook shape', () => {
  assert.strictEqual(codexManifest.hooks, './hooks/hooks.json');
  const hooksManifest = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
  assert.ok(hooksManifest.hooks, 'codex hooks manifest missing hooks block');
  for (const hookName of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'SessionEnd']) {
    assert.ok(Array.isArray(hooksManifest.hooks[hookName]), `missing ${hookName} hooks`);
    assert.ok(hooksManifest.hooks[hookName].length > 0, `${hookName} hooks empty`);
  }
});

test('manifest-drift: MCP manifests use bundled dist entrypoint', () => {
  const expectedArgs = ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs'];
  assert.deepStrictEqual(
    claudeManifest.mcpServers['deep-memory'].args,
    expectedArgs,
    'Claude Code MCP entrypoint must use bundled dist server',
  );
  assert.deepStrictEqual(
    mcpManifest.mcpServers['deep-memory'].args,
    expectedArgs,
    'Codex MCP entrypoint must use bundled dist server via .mcp.json',
  );
  assert.ok(
    fs.existsSync(path.join(root, 'dist/mcp-server.cjs')),
    'bundled dist/mcp-server.cjs must be committed for node_modules-free installs',
  );
});
