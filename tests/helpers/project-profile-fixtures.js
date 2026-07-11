'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveProjectId } = require('../../scripts/lib/project-resolver');

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function makeValidProjectProfile(projectRoot, overrides = {}) {
  const physicalRoot = fs.realpathSync.native(path.resolve(projectRoot));
  const profile = {
    project_id: deriveProjectId(physicalRoot),
    repo: {
      remote_url_hash: sha256('no-remote'),
      root_path_hash: sha256(physicalRoot),
      default_branch: 'main',
      git_head: '',
    },
    signature: {
      languages: ['javascript'],
      runtimes: ['node'],
      topology: 'single-package',
      test_frameworks: ['node:test'],
      package_managers: ['npm'],
      agent_runtime: ['codex', 'claude-code'],
    },
    suite: { installed_plugins: ['deep-memory'] },
    privacy: { scope: 'local', allow_export: false },
    source_mtimes: {},
    generated_at: new Date().toISOString(),
  };
  return { ...profile, ...overrides };
}

function makeSameIdInvalidProfiles(validProfile) {
  return {
    missingAllowExport: {
      ...validProfile,
      privacy: { scope: validProfile.privacy.scope },
    },
    unexpectedTopLevel: {
      ...validProfile,
      unexpected: true,
    },
    invalidGeneratedAt: {
      ...validProfile,
      generated_at: 'not-a-date-time',
    },
  };
}

function writeValidProjectProfile(projectRoot) {
  const dir = path.join(projectRoot, '.deep-memory');
  fs.mkdirSync(dir, { recursive: true });
  const profile = makeValidProjectProfile(projectRoot);
  fs.writeFileSync(path.join(dir, 'project-profile.json'), JSON.stringify(profile));
  return profile;
}

module.exports = { makeValidProjectProfile, makeSameIdInvalidProfiles, writeValidProjectProfile };
