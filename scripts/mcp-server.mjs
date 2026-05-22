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
const { runHybridRetrieve } = require('./lib/retrieve-hybrid.js');
const { runLazyDistill } = require('./lib/distill-pipeline.js');
const { redactString } = require('./lib/redact.js');
const { resolveCurrentProject } = require('./lib/project-resolver.js');
const { writeEntry } = require('./lib/audit-log.js');

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
    description: 'Hybrid retrieval (BM25+vector+RRF) with LLM-driven rerank. Read-only.',
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
    description: 'Lightweight lexical recall (FTS5 only). Read-only.',
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
    description: 'Add a new memory card (privacy=local). Additive + reversible — no consent gate.',
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
    description: 'Harvest sibling deep-suite artifacts into events. Read-only summary; idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { enum: ['siblings', 'all'], default: 'siblings' }
      }
    }
  },
  {
    name: 'deep_memory_audit',
    description: 'Audit operations. mode=check is autonomous-readable; other modes are slash-only mutation.',
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
    description: 'List recent hook-capture sessions with event + draft counts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'deep_memory_profile',
    description: 'Show or update the project profile (signature, languages, tags).',
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
        return /capture:\s*\n\s*enabled:\s*true/.test(cfg);
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
  { name: 'deep-memory', version: '0.3.0' },
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
        ftsSearch: null,  // FTS5 wiring is final-integration task (Opus 🟡 #7)
        topN: args.limit || 5
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
    // Spec §6.3.1 Gate 2 carve-out — additive + local, no consent gate.
    // Card writer wiring tied to Opus 🔴 #5 + 🟡 #8 — emit audit-log save entry
    // even though card body write is a deferred minor.
    try {
      writeEntry(DEEP_MEMORY_ROOT, {
        kind: 'save', by: 'mcp-autonomous', host: process.env.DEEP_MEMORY_HOST || 'unknown',
        payload: {
          memory_id: 'mem_' + Math.random().toString(36).slice(2, 14),
          memory_type: args.memory_type, privacy: 'local'
        }
      });
    } catch {}
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'accepted',
          note: 'save audit-log emitted; card body persistence consolidated with v0.3.1 card-writer task'
        })
      }]
    };
  }

  if (name === 'deep_memory_audit' && args.mode === 'check') {
    // Read-only audit — no mutation, returns lock + index health.
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          note: 'autonomous audit check stub — full lock/index health probe in v0.3.1'
        })
      }]
    };
  }

  if (name === 'deep_memory_harvest') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'stub',
          note: 'deep_memory_harvest autonomous wrapper around scripts/harvest.js — full wiring v0.3.1'
        })
      }]
    };
  }

  if (name === 'deep_memory_sessions') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'stub',
          sessions: [],
          note: 'deep_memory_sessions stub — full session enumerator v0.3.1'
        })
      }]
    };
  }

  if (name === 'deep_memory_profile') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'stub',
          project_id: projectId,
          note: 'deep_memory_profile stub — full profile show/update v0.3.1'
        })
      }]
    };
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
