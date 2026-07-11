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
  SessionStart: 'session-start.mjs',
  UserPromptSubmit: 'user-prompt-submit.mjs',
  PostToolUse: 'post-tool-use.mjs',
  PostToolUseFailure: 'post-tool-failure.mjs',
  PreCompact: 'pre-compact.mjs',
  SessionEnd: 'session-end.mjs',
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
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = codexHooks.hooks && codexHooks.hooks[event];
    const handlers = Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks || []) : [];
    const handler = handlers.length === 1 ? handlers[0] : null;
    const script = HOOK_SCRIPT[event];
    if (!handler || handler.type !== 'command'
        || handler.command !== `node "\${PLUGIN_ROOT}/scripts/hooks/${script}"`
        || handler.commandWindows !== `node "%PLUGIN_ROOT%\\scripts\\hooks\\${script}"`) {
      errors.push(`Codex hook '${event}' must have exact Unix and Windows commands`);
    }
  }

  const claudeEventNames = Object.keys(claude.hooks || {}).sort();
  if (JSON.stringify(claudeEventNames) !== JSON.stringify(CLAUDE_HOOK_EVENTS)) {
    errors.push('Claude hooks must retain exactly all six events');
  }
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entries = claude.hooks && claude.hooks[event];
    const handlers = Array.isArray(entries) ? entries.flatMap((entry) => entry.hooks || []) : [];
    const handler = handlers.length === 1 ? handlers[0] : null;
    if (!handler || handler.type !== 'command'
        || handler.command !== `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hooks/${HOOK_SCRIPT[event]}"`) {
      errors.push(`Claude hook '${event}' must retain its exact quoted command`);
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
