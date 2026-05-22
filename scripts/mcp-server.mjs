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
const { redactString } = require('./lib/redact.js');

const DEEP_MEMORY_ROOT = process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');

// ---- Tool definitions (10 total) -----------------------------------------

const TOOLS = [
  {
    name: 'deep_memory_recall',
    description: 'Retrieve task-relevant memory cards. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Current task description for relevance filtering' },
        top_n: { type: 'integer', default: 5, minimum: 1, maximum: 20 }
      },
      required: ['task']
    }
  },
  {
    name: 'deep_memory_search',
    description: 'Full-text + semantic search across memory cards. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        top_n: { type: 'integer', default: 5 }
      },
      required: ['query']
    }
  },
  {
    name: 'deep_memory_smart_search',
    description: 'Hybrid retrieval with LLM-driven reranking. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, top_n: { type: 'integer', default: 5 } },
      required: ['query']
    }
  },
  {
    name: 'deep_memory_save',
    description: 'Add a new memory card (privacy=local only). Additive + reversible — no consent gate.',
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
    name: 'deep_memory_forget',
    description: 'Delete a memory card. Mutation — slash-only in v0.3.0 (use /deep-memory-forget).',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string' }, reason: { type: 'string' } },
      required: ['memory_id']
    }
  },
  {
    name: 'deep_memory_audit_unlock',
    description: 'Break a stale lock. Mutation — slash-only in v0.3.0.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deep_memory_audit_promote',
    description: 'Promote a card from local→global. Mutation — slash-only in v0.3.0.',
    inputSchema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] }
  },
  {
    name: 'deep_memory_audit_rebuild_index',
    description: 'Rebuild the FTS5 lexical index. Mutation — slash-only in v0.3.0.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deep_memory_audit_rebuild_vectors',
    description: 'Rebuild the vector index. Mutation — slash-only in v0.3.0.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deep_memory_export_cards',
    description: 'Export cards to JSON (cross-project view). Mutation — slash-only in v0.3.0.',
    inputSchema: {
      type: 'object',
      properties: { scope: { enum: ['current-project', 'all'] }, target_path: { type: 'string' } },
      required: ['scope', 'target_path']
    }
  }
];

// ---- Slash-only mutation tools (R3-B option-a) ----------------------------

const MUTATION_TOOLS = new Set([
  'deep_memory_forget',
  'deep_memory_audit_unlock',
  'deep_memory_audit_promote',
  'deep_memory_audit_rebuild_index',
  'deep_memory_audit_rebuild_vectors',
  'deep_memory_export_cards'
]);

function slashOnlyError(toolName) {
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
  const { name, arguments: args } = req.params;

  // Gate 2 — slash-only mutation tools
  if (MUTATION_TOOLS.has(name)) {
    return slashOnlyError(name);
  }

  if (name === 'deep_memory_recall' || name === 'deep_memory_search' || name === 'deep_memory_smart_search') {
    try {
      const projectId = process.env.DEEP_MEMORY_PROJECT_ID || 'unknown';
      const query = args.query || args.task || '';
      const result = await runHybridRetrieve({
        query,
        currentProjectId: projectId,
        root: DEEP_MEMORY_ROOT,
        ftsSearch: null,  // FTS5 wiring deferred — caller-supplied in production
        topN: args.top_n || 5
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'retrieval_failed', message: e.message }) }],
        isError: true
      };
    }
  }

  if (name === 'deep_memory_save') {
    // R3-B option-a: save is ADDITIVE + LOCAL — no consent gate per spec §6.3.1.
    // For v0.3.0 stub, log + return; full card-write wiring is final-phase task.
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'stub',
          note: 'deep_memory_save stub — full card writer wiring scheduled for final phase'
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
