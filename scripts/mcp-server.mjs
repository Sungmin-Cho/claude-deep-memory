#!/usr/bin/env node
// scripts/mcp-server.mjs
// δ.1 — MCP server entry. Spawned automatically by host (Claude Code / Codex)
// via `.mcp.json` or `mcpServers` config — never run manually by user.
//
// Implements 10 tools + 5 resources + 2 prompts per spec §6.2. All mutation
// tools (forget, audit-promote, audit-unlock, audit-rebuild-*, export-cards)
// return slash_only_in_v030 error per Gate 2 (R3-B option-a — slash-only
// mutation, no consent_token machinery).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const { runHybridRetrieve } = require('./lib/retrieve-hybrid.js');
const { makeFtsSearch } = require('./lib/mcp-fts-search.js');
const { runLazyDistill } = require('./lib/distill-pipeline.js');
const { redactString } = require('./lib/redact.js');
const { resolveCurrentProject } = require('./lib/project-resolver.js');
const { writeEntry } = require('./lib/audit-log.js');

// Honest not-implemented reply for autonomous MCP tools whose full behavior is
// not wired in v0.3.x. Returns `isError: true` (never `slash_only_in_v030`, which
// is reserved for the mutation gate) so the model does not mistake a stub for a
// real success. `recommended` points at the real slash command when one exists.
function notImplemented(toolName, message, recommended = null) {
  const body = { error: 'not_implemented', tool: toolName, message };
  if (recommended) body.recommended = recommended;
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

// IMPL-R1-A — Tool names now align with spec §6.3 enumeration (10 tools).
// Mutation tools (R3-B option-a Gate 2): forget, audit (with mode != check),
// export. All other tools are autonomous-readable.

const TOOLS = [
  {
    name: 'deep_memory_brief',
    description: 'Top-N task-specific memory brief. Read-only; runs Stage 0a Lazy distill first.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Current task description' },
        limit: { type: 'integer', default: 5, minimum: 1, maximum: 20 },
        project_scope: { const: 'current' }
      },
      required: ['task']
    }
  },
  {
    name: 'deep_memory_smart_search',
    description: 'Hybrid retrieval (FTS5 BM25 + optional vector stream, RRF-fused). Vector stream is used only when @xenova/transformers is installed; otherwise FTS5-only. Returns candidate card references. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
        project_scope: { const: 'current' }
      },
      required: ['query']
    }
  },
  {
    name: 'deep_memory_recall',
    description: 'Lightweight lexical recall (FTS5 BM25 only). Returns candidate card references. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
        project_scope: { const: 'current' }
      },
      required: ['query']
    }
  },
  {
    name: 'deep_memory_save',
    description: 'NOT IMPLEMENTED in v0.3.x — returns an error. Manual card creation is unsupported; memory cards are produced only by harvesting sibling deep-suite artifacts (run /deep-memory-harvest).',
    inputSchema: {
      type: 'object',
      properties: {
        memory_type: { enum: ['pattern', 'failure-case', 'architecture-decision', 'coding-style', 'experiment-outcome'] },
        title: { type: 'string' },
        claim: { type: 'string' },
        evidence_summary: { type: 'array', items: { type: 'string' } }
      },
      required: ['memory_type', 'title', 'claim']
    }
  },
  {
    name: 'deep_memory_harvest',
    description: 'NOT IMPLEMENTED as an autonomous MCP tool in v0.3.x — returns an error. Run /deep-memory-harvest instead.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { enum: ['siblings', 'all'], default: 'siblings' }
      }
    }
  },
  {
    name: 'deep_memory_audit',
    description: 'Audit operations. mode=check is NOT IMPLEMENTED in v0.3.x (returns an error — run /deep-memory-audit); other modes are slash-only mutation.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { enum: ['check', 'unlock', 'promote', 'rebuild-index', 'rebuild-vectors'] },
        memory_id: { type: 'string' }
      },
      required: ['mode']
    }
  },
  {
    name: 'deep_memory_forget',
    description: 'Delete a memory card. Mutation — slash-only in v0.3.0 (use /deep-memory-forget).',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['memory_id']
    }
  },
  {
    name: 'deep_memory_sessions',
    description: 'NOT IMPLEMENTED in v0.3.x — returns an error. Session enumeration is not yet available.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'deep_memory_profile',
    description: 'NOT IMPLEMENTED in v0.3.x — returns an error. Project profile show/update is not yet available.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { enum: ['show', 'update'], default: 'show' }
      }
    }
  },
  {
    name: 'deep_memory_export',
    description: 'Export memory cards to JSON. scope=all is slash-only (Gate 3).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { enum: ['current-project', 'all'] },
        target_path: { type: 'string' }
      },
      required: ['scope', 'target_path']
    }
  }
];

// ---- Mutation-gate enforcement (R3-B option-a + spec §6.3.1 Gate 2/3) ------
// A tool call is rejected with slash_only_in_v030 when:
//   - tool is `deep_memory_forget`
//   - tool is `deep_memory_audit` with mode != 'check'
//   - tool is `deep_memory_export` with scope == 'all' (Gate 3)
// All other autonomous calls proceed. Each rejection emits a `gate-violation`
// audit-log entry per IMPL-R1-D.

function isAutonomousAllowed(toolName, args) {
  if (toolName === 'deep_memory_forget') return false;
  if (toolName === 'deep_memory_audit' && args && args.mode && args.mode !== 'check') return false;
  if (toolName === 'deep_memory_export' && args && args.scope === 'all') return false;
  return true;
}

function slashOnlyError(toolName, args = {}) {
  // IMPL-R1-D — emit gate-violation audit-log entry on every rejection.
  try {
    writeEntry(DEEP_MEMORY_ROOT, {
      kind: 'gate-violation',
      by: 'mcp-autonomous',
      host: process.env.DEEP_MEMORY_HOST || 'unknown',
      payload: {
        tool: toolName.replace('deep_memory_', ''),
        requested_scope: JSON.stringify(args).slice(0, 200),
        denial_reason: 'gate2',
        error: 'slash_only_in_v030'
      }
    });
  } catch {
    // Best-effort — audit-log failure must not block the gate response.
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'slash_only_in_v030',
        tool: toolName,
        message: `Tool '${toolName}' is mutation-only and requires explicit user consent via slash command. Use the equivalent /deep-memory-* slash command instead. (spec §6.3.1 Gate 2; v0.3.0 R3-B option-a)`,
        recommended: `Run '/deep-memory-${toolName.replace('deep_memory_', '').replace(/_/g, '-')}' in your CLI.`
      })
    }],
    isError: true
  };
}

// ---- Resources (5 total) -------------------------------------------------

const RESOURCES = [
  { uri: 'deep-memory://status',          name: 'status',          description: 'Capture state + index health' },
  { uri: 'deep-memory://recent-briefs',   name: 'recent-briefs',   description: 'Last 10 brief invocations' },
  { uri: 'deep-memory://cards-stats',     name: 'cards-stats',     description: 'Per-type card counts' },
  { uri: 'deep-memory://config',          name: 'config',          description: 'Effective config.yaml (redacted)' },
  { uri: 'deep-memory://latest-distill',  name: 'latest-distill',  description: 'Last distill run summary' }
];

function readResource(uri) {
  if (uri === 'deep-memory://config') {
    try {
      const cfg = fs.readFileSync(path.join(DEEP_MEMORY_ROOT, 'config.yaml'), 'utf8');
      return { contents: [{ uri, mimeType: 'text/yaml', text: redactString(cfg) }] };
    } catch {
      return { contents: [{ uri, mimeType: 'text/yaml', text: '# config.yaml not present' }] };
    }
  }
  if (uri === 'deep-memory://status') {
    const captureEnabled = (() => {
      try {
        const cfg = fs.readFileSync(path.join(DEEP_MEMORY_ROOT, 'config.yaml'), 'utf8');
        return /^capture:[ \t]*\r?\n[ \t]+enabled:[ \t]*true\b/m.test(cfg); // column-0 top-level only (R4 N4 + R5 N6)
      } catch { return false; }
    })();
    const status = { capture_enabled: captureEnabled, root: DEEP_MEMORY_ROOT };
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(status, null, 2) }] };
  }
  if (uri === 'deep-memory://latest-distill') {
    // Read from per-project .deep-memory/latest-distill.json — fallback empty
    return { contents: [{ uri, mimeType: 'application/json', text: '{"note": "not implemented in this stub"}' }] };
  }
  if (uri === 'deep-memory://recent-briefs' || uri === 'deep-memory://cards-stats') {
    return { contents: [{ uri, mimeType: 'application/json', text: '{}' }] };
  }
  return { contents: [{ uri, mimeType: 'text/plain', text: 'unknown resource' }] };
}

// ---- Prompts (2 total) ---------------------------------------------------

const PROMPTS = [
  {
    name: 'recall_for_task',
    description: 'Recall memory for a specific task',
    arguments: [{ name: 'task', description: 'task description', required: true }]
  },
  {
    name: 'reflect_on_session',
    description: 'Reflect on the current session and extract patterns',
    arguments: []
  }
];

// ---- Server setup --------------------------------------------------------

const server = new Server(
  { name: 'deep-memory', version: pkg.version },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // IMPL-R1-A + R3-B option-a — Gate 2/3 enforcement (mutation tools).
  if (!isAutonomousAllowed(name, args)) {
    return slashOnlyError(name, args);
  }

  // IMPL-R1-B — projectId from CWD (shared resolver), not env var.
  const projectId = resolveCurrentProject(process.env.PROJECT_CWD || process.cwd());

  // IMPL-R1-C — read tools run Stage 0a Lazy distill BEFORE retrieval.
  // brief, smart_search, recall all share this prelude.
  if (name === 'deep_memory_brief' || name === 'deep_memory_smart_search' || name === 'deep_memory_recall') {
    let distillResult = null;
    try {
      distillResult = await runLazyDistill({
        root: DEEP_MEMORY_ROOT, projectId,
        config: { skip_llm: true, distill: { detectors: { session_summary: { always_emit: false } } } }
      });
    } catch (e) {
      // Stage 0a is best-effort; retrieval proceeds with a warning.
      distillResult = { warnings: [`stage_0a_failed: ${e.message}`] };
    }
    try {
      const query = args.query || args.task || '';
      const result = await runHybridRetrieve({
        query, currentProjectId: projectId, root: DEEP_MEMORY_ROOT,
        ftsSearch: makeFtsSearch(DEEP_MEMORY_ROOT),  // real FTS5 lexical stream (degrades gracefully)
        topN: args.limit || 5,
        // R4 #4 — recall is advertised "FTS5 BM25 only": keep it lexical-only
        // even when a vector model/index is available.
        useVector: name !== 'deep_memory_recall'
      });
      // Stage 0a warnings surface alongside retrieval results.
      result.distill = distillResult;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'retrieval_failed', message: e.message }) }],
        isError: true
      };
    }
  }

  if (name === 'deep_memory_save') {
    // Honesty (P0): the previous handler wrote an audit-log 'save' entry with a
    // random memory_id and returned {status:'accepted'} while persisting NO card
    // body — a silent failure that made the model believe a card was saved.
    // Manual card creation is a deferred feature (no /deep-memory-save command
    // exists; cards are produced only by harvesting sibling artifacts), so fail
    // honestly instead of faking success. No audit-log entry is written because
    // nothing was saved.
    return notImplemented(
      'deep_memory_save',
      'Manual memory-card creation is not implemented in v0.3.x. Memory cards are ' +
      'produced by harvesting sibling deep-suite artifacts (deep-work / deep-review / ' +
      'deep-evolve / deep-docs / deep-wiki). Run /deep-memory-harvest to distill cards ' +
      'from those outputs. No card was saved.',
      "Run '/deep-memory-harvest' in your CLI."
    );
  }

  if (name === 'deep_memory_audit' && args.mode === 'check') {
    // The prior stub returned {status:'ok'} without probing anything — a false
    // clean bill of health. Fail honestly until the lock/index health probe is wired.
    return notImplemented(
      'deep_memory_audit',
      'Autonomous audit check (mode=check) is not implemented in v0.3.x. Run /deep-memory-audit.',
      "Run '/deep-memory-audit' in your CLI."
    );
  }

  if (name === 'deep_memory_harvest') {
    return notImplemented(
      'deep_memory_harvest',
      'Harvest is not implemented as an autonomous MCP tool in v0.3.x. Run /deep-memory-harvest.',
      "Run '/deep-memory-harvest' in your CLI."
    );
  }

  if (name === 'deep_memory_sessions') {
    return notImplemented(
      'deep_memory_sessions',
      'Session enumeration is not implemented in v0.3.x.'
    );
  }

  if (name === 'deep_memory_profile') {
    return notImplemented(
      'deep_memory_profile',
      'Project profile show/update is not implemented in v0.3.x.'
    );
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool', tool: name }) }],
    isError: true
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'recall_for_task') {
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Recall memory cards relevant to: ${args?.task || '(no task provided)'}` }
      }]
    };
  }
  if (name === 'reflect_on_session') {
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: 'Reflect on the current session and identify any reusable patterns, decisions, or failure recoveries worth saving as memory cards.' }
      }]
    };
  }
  return { messages: [] };
});

// ---- Bootstrap -----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
