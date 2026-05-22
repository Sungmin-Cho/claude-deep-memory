'use strict';
// scripts/lib/project-resolver.js
// IMPL-R1-B lift — shared project_id resolver used by hooks (common.mjs)
// and MCP server. Reads .deep-memory/project-profile.json from CWD or falls
// back to a sha256-derived ID over CWD path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function resolveCurrentProject(cwd) {
  const startDir = cwd || process.env.PROJECT_CWD || process.cwd();
  const profilePath = path.join(startDir, '.deep-memory', 'project-profile.json');
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.project_id) return profile.project_id;
  } catch {}
  return 'proj_' + crypto.createHash('sha256').update(startDir).digest('hex').slice(0, 16);
}

module.exports = { resolveCurrentProject };
