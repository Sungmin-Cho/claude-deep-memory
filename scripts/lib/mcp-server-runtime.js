'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const pkg = require('../../package.json');
const { resolveRuntimeRoots } = require('./resource-root-resolver');
const { resolveProjectScope } = require('./project-resolver');
const { makeFtsSearch } = require('./mcp-fts-search');
const { runHybridRetrieve } = require('./retrieve-hybrid');
const { redactString } = require('./redact');

const TOOLS = Object.freeze([
  ['deep_memory_brief', 'Top-N task-specific memory brief.', { task: { type: 'string' }, limit: { type: 'integer' } }, ['task']],
  ['deep_memory_smart_search', 'Hybrid operational-memory search.', { query: { type: 'string' }, limit: { type: 'integer' } }, ['query']],
  ['deep_memory_recall', 'Lightweight FTS5 lexical recall.', { query: { type: 'string' }, limit: { type: 'integer' } }, ['query']],
  ['deep_memory_save', 'Manual save is not implemented; harvest produces cards.', { memory_type: { type: 'string' }, title: { type: 'string' }, claim: { type: 'string' } }, ['memory_type', 'title', 'claim']],
  ['deep_memory_harvest', 'Harvest is available through the host skill.', { source: { type: 'string' } }, []],
  ['deep_memory_audit', 'Audit operations; mutations are host-skill only.', { mode: { type: 'string' }, memory_id: { type: 'string' } }, ['mode']],
  ['deep_memory_forget', 'Forget is a consent-gated host-skill mutation.', { memory_id: { type: 'string' }, reason: { type: 'string' } }, ['memory_id']],
  ['deep_memory_sessions', 'Session enumeration is not implemented.', { limit: { type: 'integer' } }, []],
  ['deep_memory_profile', 'Profile display/update is not implemented.', { action: { type: 'string' } }, []],
  ['deep_memory_export', 'Export cards; all-scope export is host-skill only.', { scope: { type: 'string' }, target_path: { type: 'string' } }, ['scope', 'target_path']],
].map(([name, description, properties, required]) => Object.freeze({
  name,
  description,
  inputSchema: { type: 'object', properties, required },
})));

const RESOURCES = Object.freeze([
  { uri: 'deep-memory://status', name: 'status', description: 'Capture state and index health' },
  { uri: 'deep-memory://recent-briefs', name: 'recent-briefs', description: 'Latest project brief' },
  { uri: 'deep-memory://cards-stats', name: 'cards-stats', description: 'Visible per-type card counts' },
  { uri: 'deep-memory://config', name: 'config', description: 'Effective redacted config' },
  { uri: 'deep-memory://latest-distill', name: 'latest-distill', description: 'Latest project distill summary' },
]);

const PROMPTS = Object.freeze([
  {
    name: 'recall_for_task',
    description: 'Recall memory for a specific task',
    arguments: [{ name: 'task', description: 'Task description', required: true }],
  },
  { name: 'reflect_on_session', description: 'Reflect on the current session', arguments: [] },
]);

function redactText(value) {
  return redactString(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function textResult(value, isError = false) {
  const result = { content: [{ type: 'text', text: redactText(value) }] };
  if (isError) result.isError = true;
  return result;
}

function notImplemented(tool, message, recommended = null) {
  return textResult({ error: 'not_implemented', tool, message, recommended }, true);
}

function isAutonomousAllowed(name, args) {
  if (name === 'deep_memory_forget') return false;
  if (name === 'deep_memory_audit' && args && args.mode !== 'check') return false;
  if (name === 'deep_memory_export' && args && args.scope === 'all') return false;
  return true;
}

function writeGateViolation(memoryRoot, name, args) {
  try {
    const { writeEntry } = require('./audit-log');
    writeEntry(memoryRoot, {
      kind: 'gate-violation',
      by: 'mcp-autonomous',
      host: process.env.DEEP_MEMORY_HOST || 'unknown',
      payload: {
        tool: name.replace('deep_memory_', ''),
        requested_scope: JSON.stringify(args || {}).slice(0, 200),
        denial_reason: 'gate2',
        error: 'slash_only_in_v030',
      },
    });
  } catch {
    // The mutation remains denied even if best-effort audit persistence fails.
  }
}

function slashOnly(memoryRoot, name, args) {
  writeGateViolation(memoryRoot, name, args);
  return textResult({
    error: 'slash_only_in_v030',
    tool: name,
    message: 'This mutation requires explicit user consent through the deep-memory host skill.',
  }, true);
}

async function runLazyDistill(memoryRoot, projectId) {
  if (!projectId) return { skipped: true, reason: 'global_only_scope' };
  try {
    const { runLazyDistill: run } = require('./distill-pipeline');
    return await run({
      root: memoryRoot,
      projectId,
      config: { skip_llm: true, distill: { detectors: { session_summary: { always_emit: false } } } },
    });
  } catch (error) {
    return { warnings: [`stage_0a_failed: ${redactText(error && error.message)}`] };
  }
}

function readTextFile(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return fallback; }
}

function visibleCardStats(memoryRoot, projectScope) {
  const cardsRoot = path.join(memoryRoot, 'cards');
  const counts = {};
  let types = [];
  try { types = fs.readdirSync(cardsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); }
  catch { return counts; }
  const scopes = ['global'];
  if (projectScope.projectId) scopes.push(projectScope.projectId);
  for (const type of types.sort((a, b) => a.name.localeCompare(b.name))) {
    let count = 0;
    for (const scope of scopes) {
      const dir = path.join(cardsRoot, type.name, scope);
      try {
        count += fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
      } catch {}
    }
    counts[type.name] = count;
  }
  return counts;
}

function resourceReader({ memoryRoot, workspaceRoot, projectScope }) {
  const trustedWorkspaceRoot = projectScope.scope === 'project' && projectScope.projectId
    ? workspaceRoot
    : null;
  return (uri) => {
    let mimeType = 'application/json';
    let value;
    if (uri === 'deep-memory://config') {
      mimeType = 'text/yaml';
      value = readTextFile(path.join(memoryRoot, 'config.yaml'), '# config.yaml not present');
    } else if (uri === 'deep-memory://status') {
      const config = readTextFile(path.join(memoryRoot, 'config.yaml'), '');
      value = {
        capture_enabled: /^capture:[ \t]*\r?\n[ \t]+enabled:[ \t]*true\b/m.test(config),
        scope: projectScope.scope,
        project_id: projectScope.projectId,
      };
    } else if (uri === 'deep-memory://cards-stats') {
      value = visibleCardStats(memoryRoot, projectScope);
    } else if (uri === 'deep-memory://recent-briefs') {
      value = trustedWorkspaceRoot
        ? readTextFile(path.join(trustedWorkspaceRoot, '.deep-memory', 'latest-brief.json'), '{}')
        : '{}';
    } else if (uri === 'deep-memory://latest-distill') {
      value = trustedWorkspaceRoot
        ? readTextFile(path.join(trustedWorkspaceRoot, '.deep-memory', 'latest-distill.json'), '{}')
        : '{}';
    } else {
      mimeType = 'text/plain';
      value = 'unknown resource';
    }
    const text = typeof value === 'string' ? redactText(value) : redactText(value);
    return { contents: [{ uri, mimeType, text }] };
  };
}

function createServer({ roots, projectScope }) {
  const server = new Server(
    { name: 'deep-memory', version: pkg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  const readResource = resourceReader({
    memoryRoot: roots.memoryRoot,
    workspaceRoot: roots.workspaceRoot,
    projectScope,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (!isAutonomousAllowed(name, args)) return slashOnly(roots.memoryRoot, name, args);

    if (['deep_memory_brief', 'deep_memory_smart_search', 'deep_memory_recall'].includes(name)) {
      const distill = await runLazyDistill(roots.memoryRoot, projectScope.projectId);
      try {
        const result = await runHybridRetrieve({
          query: args.query || args.task || '',
          currentProjectId: projectScope.projectId,
          root: roots.memoryRoot,
          ftsSearch: makeFtsSearch(roots.memoryRoot),
          topN: args.limit || 5,
          useVector: name !== 'deep_memory_recall',
        });
        result.distill = distill;
        return textResult(result);
      } catch (error) {
        return textResult({ error: 'retrieval_failed', message: error && error.message }, true);
      }
    }

    if (name === 'deep_memory_save') {
      return notImplemented(name, 'Manual card creation is not implemented. Run deep-memory-harvest.');
    }
    if (name === 'deep_memory_harvest') {
      return notImplemented(name, 'Autonomous harvest is not implemented. Run the deep-memory-harvest skill.');
    }
    if (name === 'deep_memory_audit' && args.mode === 'check') {
      return notImplemented(name, 'Autonomous audit check is not implemented. Run the deep-memory-audit skill.');
    }
    if (name === 'deep_memory_sessions') return notImplemented(name, 'Session enumeration is not implemented.');
    if (name === 'deep_memory_profile') return notImplemented(name, 'Profile update/display is not implemented.');
    return textResult({ error: 'unknown_tool', tool: name }, true);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(request.params.uri));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const text = name === 'recall_for_task'
      ? `Recall memory cards relevant to: ${args && args.task ? args.task : '(no task provided)'}`
      : 'Reflect on this session and identify reusable operational patterns.';
    return { messages: [{ role: 'user', content: { type: 'text', text } }] };
  });
  return server;
}

async function startMcpServer({ entryDir } = {}) {
  const roots = resolveRuntimeRoots({ entryDir });
  const projectScope = resolveProjectScope(roots.workspaceRoot);
  const server = createServer({ roots, projectScope });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, roots, projectScope };
}

module.exports = { startMcpServer, createServer, TOOLS, RESOURCES, PROMPTS };
