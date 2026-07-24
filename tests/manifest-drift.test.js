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
const codexHooksPath = path.join(root, 'hooks', 'hooks.json');
const mcpManifest = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
const initSkill = fs.readFileSync(path.join(root, 'skills', 'deep-memory-init', 'SKILL.md'), 'utf8');
const hookArtifacts = [
  'post-tool-failure.cjs',
  'post-tool-use.cjs',
  'pre-compact.cjs',
  'session-end.cjs',
  'session-start.cjs',
  'user-prompt-submit.cjs',
];

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
    const fmMatch = txt.match(/^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/);
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

test('manifest-drift: all agent frontmatter is strict YAML with bounded required metadata', () => {
  const agentsDir = path.join(root, 'agents');
  if (!fs.existsSync(agentsDir)) return;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const txt = fs.readFileSync(path.join(agentsDir, entry.name), 'utf8');
    const fmMatch = txt.match(/^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/);
    assert.ok(fmMatch, `${entry.name}: no frontmatter`);

    let fm;
    try { fm = yaml.load(fmMatch[1]); }
    catch (e) { assert.fail(`${entry.name}: strict YAML parse error: ${e.message}`); }

    assert.ok(fm && typeof fm === 'object' && !Array.isArray(fm),
      `${entry.name}: frontmatter must be a mapping`);
    assert.ok(typeof fm.name === 'string' && fm.name.trim().length > 0,
      `${entry.name}: missing name`);
    assert.ok(typeof fm.description === 'string' && fm.description.trim().length > 0,
      `${entry.name}: missing description`);
    assert.ok(fm.description.length <= 1024,
      `${entry.name}: description ${fm.description.length} chars (host limit)`);
    assert.ok(typeof fm.tools === 'string' && fm.tools.trim().length > 0,
      `${entry.name}: tools must be a non-empty comma-separated string`);
    assert.ok(fm.tools.split(',').every((tool) => tool.trim().length > 0),
      `${entry.name}: tools contains an empty entry`);
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

test('manifest-drift: Codex default hooks contain the exact supported host subset', () => {
  assert.strictEqual(Object.hasOwn(codexManifest, 'hooks'), false);
  const hooksManifest = JSON.parse(fs.readFileSync(codexHooksPath, 'utf8'));
  assert.ok(hooksManifest.hooks, 'codex hooks manifest missing hooks block');
  assert.deepStrictEqual(
    Object.keys(hooksManifest.hooks).sort(),
    ['PostToolUse', 'PreCompact', 'SessionStart', 'UserPromptSubmit'],
  );
  for (const hookName of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact']) {
    assert.ok(Array.isArray(hooksManifest.hooks[hookName]), `missing ${hookName} hooks`);
    assert.ok(hooksManifest.hooks[hookName].length > 0, `${hookName} hooks empty`);
    const handlers = hooksManifest.hooks[hookName].flatMap((entry) => entry.hooks || []);
    assert.strictEqual(handlers.length, 1, `${hookName} must have one handler`);
    // E5: claude-host-guarded env-bootstrap — Claude Code auto-loads this file.
    assert.match(handlers[0].command, /^node -e "/);
    assert.doesNotMatch(handlers[0].command, /\$\{/);
    assert.match(handlers[0].command, /process\.env\.CLAUDE_PLUGIN_ROOT/);
    assert.match(handlers[0].command, /scripts','hook-bootstrap\.cjs/);
    assert.strictEqual(handlers[0].commandWindows, handlers[0].command);
  }
});

test('manifest-drift: Claude loads its six-event hooks from the fail-open bootstrap file', () => {
  assert.strictEqual(claudeManifest.hooks, './hooks/hooks.claude.json');
  const claudeHooks = JSON.parse(
    fs.readFileSync(path.join(root, 'hooks', 'hooks.claude.json'), 'utf8'),
  ).hooks;
  const expected = ['PostToolUse', 'PostToolUseFailure', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit'];
  assert.deepStrictEqual(Object.keys(claudeHooks).sort(), expected);
  for (const event of expected) {
    const handlers = claudeHooks[event].flatMap((entry) => entry.hooks || []);
    assert.strictEqual(handlers.length, 1, event);
    assert.match(handlers[0].command, /^node -e "/, event);
    assert.doesNotMatch(handlers[0].command, /\$\{/, event);
    assert.match(handlers[0].command, /scripts','hook-bootstrap\.cjs/, event);
  }
});

test('manifest-drift: shipped runtimes use committed self-contained bundles', () => {
  const claudeArgs = ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs'];
  assert.deepStrictEqual(
    claudeManifest.mcpServers['deep-memory'].args,
    claudeArgs,
    'Claude Code MCP entrypoint must use bundled dist server',
  );
  assert.deepStrictEqual(
    mcpManifest.mcpServers['deep-memory'].args,
    ['./dist/mcp-server.cjs'],
    'Codex MCP entrypoint must be plugin-relative via .mcp.json',
  );
  assert.strictEqual(mcpManifest.mcpServers['deep-memory'].cwd, '.');
  assert.ok(
    fs.existsSync(path.join(root, 'dist/mcp-server.cjs')),
    'bundled dist/mcp-server.cjs must be committed for node_modules-free installs',
  );
  assert.deepStrictEqual(
    fs.readdirSync(path.join(root, 'dist', 'hooks')).sort(),
    hookArtifacts,
    'dist/hooks must contain exactly one bundle for every shipped hook entrypoint',
  );
  for (const artifact of hookArtifacts) {
    assert.ok(fs.statSync(path.join(root, 'dist', 'hooks', artifact)).size > 0, artifact);
  }
});

test('manifest-drift: init guidance uses native Windows paths and keeps UNC opt-in explicit', () => {
  assert.match(initSkill, /C:\\Users\\me\\\.deep-memory/);
  assert.doesNotMatch(initSkill, /POSIX form 필수/);
  assert.doesNotMatch(initSkill, /Windows 사용자는 `\/c\/\.\.\.` 또는 `\/mnt\/c\/\.\.\.`/);
  assert.match(initSkill, /UNC[^\n]*--allow-network-root/);
});
