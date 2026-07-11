'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isValidProjectId } = require('./validate-project-id');
const { walkContainedCards, readContainedCard } = require('./card-paths');
const { redactString } = require('./redact');

const RESOURCES = Object.freeze([
  Object.freeze({ uri: 'deep-memory://status', name: 'status', description: 'Capture state and index health' }),
  Object.freeze({ uri: 'deep-memory://config', name: 'config', description: 'Effective redacted config' }),
  Object.freeze({ uri: 'deep-memory://cards-stats', name: 'cards-stats', description: 'Visible per-type card counts' }),
]);

function listResources() {
  return { resources: RESOURCES };
}

function normalizeProjectScope(projectScope) {
  if (projectScope && projectScope.scope === 'global' && projectScope.projectId === null) {
    return { valid: true, projectId: null, scope: 'global' };
  }
  if (projectScope && projectScope.scope === 'project' && isValidProjectId(projectScope.projectId)) {
    return { valid: true, projectId: projectScope.projectId, scope: 'project' };
  }
  return { valid: false };
}

function redactConfigText(value) {
  return redactString(String(value));
}

function countVisibleCards({
  memoryRoot,
  projectScope,
  io = fs,
  platform = process.platform,
  maxFiles = 5000,
} = {}) {
  const normalized = normalizeProjectScope(projectScope);
  if (!normalized.valid) return { available: false, reason: 'project_scope_invalid' };
  const counts = new Map();
  const warnings = new Set();
  const walked = walkContainedCards({
    root: memoryRoot,
    currentProjectId: normalized.projectId,
    maxFiles,
    io,
    platform,
    onCard(descriptor) {
      const read = readContainedCard(descriptor, { io, platform });
      if (read.warning) {
        warnings.add(read.warning);
        if (read.warning !== 'card_json_invalid') return;
      }
      counts.set(descriptor.type, (counts.get(descriptor.type) || 0) + 1);
    },
  });
  for (const warning of walked.warnings) warnings.add(warning);
  const byType = {};
  for (const type of [...counts.keys()].sort((a, b) => a.localeCompare(b))) byType[type] = counts.get(type);
  const result = {
    available: true,
    total: Object.values(byType).reduce((sum, count) => sum + count, 0),
    by_type: byType,
  };
  if (warnings.size > 0) result.warnings = [...warnings].sort();
  return result;
}

function content(uri, mimeType, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { contents: [{ uri, mimeType, text }] };
}

async function readResource(uri, {
  memoryRoot,
  workspaceRoot: _workspaceRoot,
  projectScope,
  io = fs,
  platform = process.platform,
} = {}) {
  const normalized = normalizeProjectScope(projectScope);
  if (!normalized.valid) {
    return content('deep-memory://cards-stats', 'application/json', {
      available: false,
      reason: 'project_scope_invalid',
    });
  }
  if (uri === 'deep-memory://config') {
    let value;
    try { value = io.readFileSync(path.join(memoryRoot, 'config.yaml'), 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') {
        return content(uri, 'application/json', { available: false, reason: 'config_missing' });
      }
      return content(uri, 'application/json', { available: false, reason: 'config_unavailable' });
    }
    return content(uri, 'text/yaml', redactConfigText(value));
  }
  if (uri === 'deep-memory://status') {
    let config = '';
    try { config = io.readFileSync(path.join(memoryRoot, 'config.yaml'), 'utf8'); }
    catch {}
    return content(uri, 'application/json', {
      available: true,
      capture_enabled: /^capture:[ \t]*\r?\n[ \t]+enabled:[ \t]*true\b/m.test(config),
      scope: normalized.scope,
      project_id: normalized.projectId,
    });
  }
  if (uri === 'deep-memory://cards-stats') {
    return content(uri, 'application/json', countVisibleCards({
      memoryRoot,
      projectScope,
      io,
      platform,
    }));
  }
  return content('deep-memory://unknown', 'application/json', {
    available: false,
    reason: 'unknown_resource',
  });
}

module.exports = { listResources, readResource, countVisibleCards, redactConfigText };
