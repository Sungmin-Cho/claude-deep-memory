'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ALLOWED_CODEX_FIELDS = new Set([
  'id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers',
  'interface', 'author', 'homepage', 'repository', 'license', 'keywords',
]);
const CODEX_HOOK_EVENTS = Object.freeze(['PostToolUse', 'PreCompact', 'SessionStart', 'UserPromptSubmit']);
const CLAUDE_HOOK_EVENTS = Object.freeze([
  'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit',
]);
const HOOK_SCRIPT = Object.freeze({
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PostToolUse: 'post-tool-use',
  PostToolUseFailure: 'post-tool-failure',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
});

function readJson(file, errors, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { errors.push(`${label} must contain valid JSON`); return null; }
}

function validatePlugin(root = process.cwd()) {
  const errors = [];
  const codex = readJson(path.join(root, '.codex-plugin/plugin.json'), errors, 'Codex manifest');
  const claude = readJson(path.join(root, '.claude-plugin/plugin.json'), errors, 'Claude manifest');
  const pkg = readJson(path.join(root, 'package.json'), errors, 'package.json');
  const mcp = readJson(path.join(root, '.mcp.json'), errors, '.mcp.json');
  const codexHooks = readJson(path.join(root, 'hooks/hooks.json'), errors, 'Codex hooks');
  if (!codex || !claude || !pkg || !mcp || !codexHooks) return errors;

  for (const key of Object.keys(codex).sort()) {
    if (!ALLOWED_CODEX_FIELDS.has(key)) errors.push(`Codex manifest field '${key}' is not accepted`);
  }
  if (codex.name !== 'deep-memory') errors.push('Codex manifest name must be deep-memory');
  if (codex.skills !== './skills/') errors.push("Codex skills must resolve to './skills/'");
  if (codex.mcpServers !== './.mcp.json') errors.push("Codex mcpServers must resolve to './.mcp.json'");
  if (Object.hasOwn(codex, 'hooks')) errors.push('Codex manifest must use default hook discovery');
  if (codex.version !== pkg.version || claude.version !== pkg.version) errors.push('version triple must match');

  const codexEventNames = Object.keys(codexHooks.hooks || {}).sort();
  if (JSON.stringify(codexEventNames) !== JSON.stringify(CODEX_HOOK_EVENTS)) {
    errors.push('Codex hooks must contain exactly the four supported events');
  }
  // Claude Code auto-loads the standard hooks/hooks.json in addition to the
  // manifest.hooks file, so the Codex discovery file must be a shell-safe
  // env-bootstrap that delegates to hooks.claude.json on a Claude host (E5) —
  // the old `node "${PLUGIN_ROOT}/..."` form crashed there on every event.
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = codexHooks.hooks && codexHooks.hooks[event];
    const handlers = Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks || []) : [];
    const handler = handlers.length === 1 ? handlers[0] : null;
    const command = handler && typeof handler.command === 'string' ? handler.command : '';
    if (!handler || handler.type !== 'command'
        || !command.startsWith('node -e "')
        || command.includes('${')
        || !command.includes('process.env.CLAUDE_PLUGIN_ROOT')
        || !command.includes('process.env.PLUGIN_ROOT')
        || !command.includes(`'scripts','hook-bootstrap.cjs'`)
        || !command.includes(`.run('${HOOK_SCRIPT[event]}')`)
        || handler.commandWindows !== command) {
      errors.push(`Codex hook '${event}' command must be a claude-host-guarded fail-open env-bootstrap`);
    }
  }

  // Claude loads its six capture hooks from a dedicated file manifest whose
  // commands are fail-OPEN env-bootstraps — an INLINE manifest hook does not
  // expand ${CLAUDE_PLUGIN_ROOT}, which silently broke every capture (E4).
  if (claude.hooks !== './hooks/hooks.claude.json') {
    errors.push("Claude manifest hooks must point to './hooks/hooks.claude.json'");
  }
  const claudeHooks = readJson(path.join(root, 'hooks/hooks.claude.json'), errors, 'Claude hooks');
  const claudeEventNames = Object.keys((claudeHooks && claudeHooks.hooks) || {}).sort();
  if (JSON.stringify(claudeEventNames) !== JSON.stringify(CLAUDE_HOOK_EVENTS)) {
    errors.push('Claude hooks must retain exactly all six events');
  }
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entries = claudeHooks && claudeHooks.hooks && claudeHooks.hooks[event];
    const handlers = Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks || []) : [];
    const handler = handlers.length === 1 ? handlers[0] : null;
    const command = handler && typeof handler.command === 'string' ? handler.command : '';
    if (!handler || handler.type !== 'command'
        || !command.startsWith('node -e "')
        || command.includes('${')
        || !command.includes(`'scripts','hook-bootstrap.cjs'`)
        || !command.includes(`.run('${HOOK_SCRIPT[event]}')`)) {
      errors.push(`Claude hook '${event}' must be a fail-open env-bootstrap for its script`);
    }
  }
  if (!fs.existsSync(path.join(root, 'scripts', 'hook-bootstrap.cjs'))) {
    errors.push('hook runtime bootstrap is missing');
  }
  for (const artifact of new Set(Object.values(HOOK_SCRIPT))) {
    if (!fs.existsSync(path.join(root, 'dist', 'hooks', `${artifact}.cjs`))) {
      errors.push(`committed hook bundle '${artifact}.cjs' is missing`);
    }
  }

  const server = mcp.mcpServers && mcp.mcpServers['deep-memory'];
  if (!server || server.command !== 'node') errors.push('Codex MCP command must be node');
  if (!server || JSON.stringify(server.args) !== JSON.stringify(['./dist/mcp-server.cjs'])) {
    errors.push('Codex MCP args must be plugin-relative');
  }
  if (!server || server.cwd !== '.') errors.push("Codex MCP cwd must be '.'");
  if (!fs.existsSync(path.join(root, 'dist/mcp-server.cjs'))) errors.push('committed MCP bundle is missing');

  const skillsRoot = path.join(root, 'skills');
  for (const name of fs.readdirSync(skillsRoot).sort()) {
    const skillFile = path.join(skillsRoot, name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) { errors.push(`skill '${name}' is missing SKILL.md`); continue; }
    const text = fs.readFileSync(skillFile, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    if (!match) { errors.push(`skill '${name}' is missing YAML frontmatter`); continue; }
    try {
      const frontmatter = yaml.load(match[1]);
      if (!frontmatter || typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
        errors.push(`skill '${name}' needs non-empty name and description`);
      }
    } catch { errors.push(`skill '${name}' has invalid YAML frontmatter`); }
  }
  return errors;
}

if (require.main === module) {
  const errors = validatePlugin(process.argv[2] ? path.resolve(process.argv[2]) : process.cwd());
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('Plugin validation passed');
}

module.exports = { validatePlugin, ALLOWED_CODEX_FIELDS };
