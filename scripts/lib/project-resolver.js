'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateProjectProfile } = require('./project-profile-validator');

// Process-local dependency seam used by boundary contract tests (including the
// bundled MCP process). It is inert unless an embedding host explicitly sets
// an observer and never changes the resolver result.
const PROJECT_SCOPE_OBSERVER = Symbol.for('deep-memory.project-scope-observer');

function setProjectScopeObserver(observer) {
  if (observer !== null && typeof observer !== 'function') {
    throw new TypeError('project scope observer must be a function or null');
  }
  if (observer === null) delete globalThis[PROJECT_SCOPE_OBSERVER];
  else globalThis[PROJECT_SCOPE_OBSERVER] = observer;
}

function canonicalizeRoot(root) {
  try { return fs.realpathSync.native(root); }
  catch { return path.resolve(root); }
}

function deriveProjectId(root) {
  return `proj_${crypto.createHash('sha256').update(canonicalizeRoot(root)).digest('hex').slice(0, 12)}`;
}

function globalOnly(reason, projectRoot = null) {
  return { projectRoot, projectId: null, scope: 'global', warning: reason, profile: null };
}

function resolveProjectScope(workspaceRoot) {
  const observer = globalThis[PROJECT_SCOPE_OBSERVER];
  if (typeof observer === 'function') observer(workspaceRoot);
  if (!workspaceRoot) return globalOnly('workspace_root_unavailable');
  let projectRoot;
  try { projectRoot = fs.realpathSync.native(workspaceRoot); }
  catch { return globalOnly('project_root_unresolved'); }
  const profilePath = path.join(projectRoot, '.deep-memory', 'project-profile.json');
  let profileText;
  try { profileText = fs.readFileSync(profilePath, 'utf8'); }
  catch { return globalOnly('project_profile_missing', projectRoot); }
  let profile;
  try { profile = JSON.parse(profileText); }
  catch { return globalOnly('project_profile_invalid_json', projectRoot); }
  const validation = validateProjectProfile(profile);
  if (!validation.valid) return globalOnly(validation.reason, projectRoot);
  const expected = deriveProjectId(projectRoot);
  if (profile.project_id !== expected) return globalOnly('project_profile_id_mismatch', projectRoot);
  return { projectRoot, projectId: expected, scope: 'project', profile };
}

module.exports = {
  canonicalizeRoot,
  deriveProjectId,
  resolveProjectScope,
  setProjectScopeObserver,
};
