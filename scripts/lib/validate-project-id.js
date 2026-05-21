'use strict';
// ITEM-2-r4: validateProjectId — path-traversal guard for projectId at every
// CLI/profile entry boundary before any path.join site.
const PROJECT_ID_RE = /^proj_[a-f0-9]{12}$/;

function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    throw Object.assign(
      new Error(`Invalid project_id: ${JSON.stringify(id)} — must match /^proj_[a-f0-9]{12}$/`),
      { code: 'INVALID_PROJECT_ID' }
    );
  }
  return id;
}

function isValidProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

module.exports = { validateProjectId, isValidProjectId, PROJECT_ID_RE };
