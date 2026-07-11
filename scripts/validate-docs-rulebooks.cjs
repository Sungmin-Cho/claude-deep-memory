'use strict';
const fs = require('node:fs');

const MAX_DIAGNOSTIC_BYTES = 512;
const PLUGIN_VERSION_COMMANDS = [
  `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`,
  `node -e "console.log(require('./.codex-plugin/plugin.json').version)"`,
];
const PYTHON_RE = /\b(?:python\d*|pytest)\b/i;

function diagnostic(code, rule, detail) {
  const bounded = String(detail || '').replace(/[\r\n]+/g, ' ').slice(0, 240);
  return { code, rule, detail: bounded };
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if ((name === '--plugin-rule' || name === '--suite-rule') && i + 1 < argv.length) {
      values[name.slice(2)] = argv[++i];
    }
  }
  return values;
}

function pythonPolicyIsValid(text) {
  const sections = text.split(/(?=^##\s+)/m);
  const legacySections = sections.filter((section) => {
    const heading = (section.match(/^##\s+([^\r\n]+)/m) || [])[1] || '';
    return /legacy-oracle/i.test(heading);
  });
  if (legacySections.length !== 1 || !/Unix-only/i.test(legacySections[0])) return false;
  for (const section of sections) {
    if (!PYTHON_RE.test(section)) continue;
    for (const line of section.split(/\r?\n/)) {
      if (!PYTHON_RE.test(line) || !/(?:supported runtime|ordinary CI)/i.test(line)) continue;
      const explicitlyExcluded = /(?:not|never)[^.\n]*(?:supported runtime|ordinary CI)|(?:supported runtime|ordinary CI)[^.\n]*(?:not|never)/i.test(line);
      if (!explicitlyExcluded) return false;
    }
    const heading = (section.match(/^##\s+([^\r\n]+)/m) || [])[1] || '';
    if (/legacy-oracle/i.test(heading)) {
      if (!/Unix-only/i.test(section)) return false;
      continue;
    }
    for (const line of section.split(/\r?\n/)) {
      if (!PYTHON_RE.test(line)) continue;
      const maintainerValidator = /official Codex/i.test(line) && /maintainer-only/i.test(line);
      if (!maintainerValidator) return false;
    }
  }
  return true;
}

function validateCommonPolicy(text, rule) {
  const errors = [];
  if (/\bjq\b/i.test(text)) {
    errors.push(diagnostic('rulebook_jq_forbidden', rule, 'version and pin reads must use Node, not jq'));
  }
  const missingMatrix = ['Node 22', 'Ubuntu', 'macOS', 'Windows', 'pwsh']
    .filter((token) => !text.toLowerCase().includes(token.toLowerCase()));
  if (missingMatrix.length > 0 || !/ordinary CI/i.test(text) || !/Node-only/i.test(text)) {
    errors.push(diagnostic(
      'rulebook_ci_matrix_missing', rule,
      `Node-only ordinary CI matrix is incomplete: ${missingMatrix.join(', ') || 'policy wording'}`,
    ));
  }
  if (!pythonPolicyIsValid(text)) {
    errors.push(diagnostic(
      'rulebook_python_policy_invalid', rule,
      'Python is allowed only for the maintainer validator or a Unix-only legacy-oracle section',
    ));
  }
  return errors;
}

function validatePluginPolicy(text) {
  const missingCommands = PLUGIN_VERSION_COMMANDS.filter((command) => !text.includes(command));
  if (missingCommands.length > 0
      || !/three supported version sources|supported version sources are/i.test(text)
      || !/package-lock\.json/i.test(text)
      || !/MCP bundle/i.test(text)) {
    return [diagnostic(
      'rulebook_plugin_version_policy_missing', 'plugin',
      'plugin requires two Node manifest reads, package version, lockfile, and bundle checks',
    )];
  }
  return [];
}

function validateSuitePolicy(text) {
  const required = [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    'identical release SHA pins',
    'Read marketplace SHA pins with Node-only tooling',
    '.claude-plugin/suite-extensions.json',
    'deep-suite:auto-generated:<id>:start',
    'npm run docs:write',
    'npm run docs:sync',
  ];
  const errors = [];
  const nodeOnlyVerification = /(?:release|pin|documentation)[^\n.]*verification[^\n.]*Node-only|Node-only[^\n.]*(?:release|pin|documentation)[^\n.]*verification/i.test(text);
  if (required.some((token) => !text.includes(token)) || !nodeOnlyVerification) {
    errors.push(diagnostic(
      'rulebook_suite_policy_missing', 'suite',
      'suite requires marketplace SHA pins, sidecar metadata, and generated-doc commands',
    ));
  }
  const hasNoChangelog = /(?:has|maintains?|uses?)\s+(?:\*\*)?no CHANGELOG|does not (?:have|maintain|use)[^.\n]*CHANGELOG/i.test(text);
  const hasNoPluginTriple = /does not use a plugin version triple|no plugin version triple/i.test(text);
  const changelogDirective = /(?:add|update|create)[^\n]*CHANGELOG[^\n]*(?:entry|release)|CHANGELOG[^\n]*(?:add|update|create)[^\n]*(?:entry|release)/i.test(text);
  const pluginTripleDirective = /\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json|three supported version sources|version triple-sync|all must match/i.test(text);
  if (!hasNoChangelog || !hasNoPluginTriple || changelogDirective || pluginTripleDirective) {
    errors.push(diagnostic(
      'rulebook_suite_policy_contradiction', 'suite',
      'suite has no CHANGELOG or plugin version triple and must not prescribe either workflow',
    ));
  }
  return errors;
}

function validateRulebook(file, rule) {
  if (!file || !fs.existsSync(file)) {
    return [diagnostic('rulebook_missing', rule, 'canonical rulebook is missing')];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [diagnostic('rulebook_unreadable', rule, 'canonical rulebook is unreadable')];
  }

  const errors = validateCommonPolicy(text, rule);
  if (rule === 'plugin') errors.push(...validatePluginPolicy(text));
  else if (rule === 'suite') errors.push(...validateSuitePolicy(text));
  else errors.push(diagnostic('rulebook_role_invalid', rule, 'rulebook role must be plugin or suite'));
  return errors;
}

function validateRulebooks({ pluginRule, suiteRule }) {
  return [
    ...validateRulebook(pluginRule, 'plugin'),
    ...validateRulebook(suiteRule, 'suite'),
  ];
}

function emit(stream, value) {
  let line = JSON.stringify(value);
  if (Buffer.byteLength(line, 'utf8') > MAX_DIAGNOSTIC_BYTES) {
    line = JSON.stringify({ code: value.code, rule: value.rule, detail: 'diagnostic truncated' });
  }
  stream.write(`${line}\n`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const errors = validateRulebooks({
    pluginRule: args['plugin-rule'],
    suiteRule: args['suite-rule'],
  });
  if (errors.length > 0) {
    for (const error of errors) emit(process.stderr, error);
    process.exitCode = 1;
  } else {
    emit(process.stdout, { code: 'docs_rulebooks_valid', rule: 'all', detail: 'canonical policies aligned' });
  }
}

module.exports = {
  validateRulebooks,
  validateRulebook,
  validatePluginPolicy,
  validateSuitePolicy,
  parseArgs,
  MAX_DIAGNOSTIC_BYTES,
};
