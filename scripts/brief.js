// scripts/brief.js
//
// Skill entry point for /deep-memory-brief. Orchestrates retrieve + brief-format
// + atomic write. All ranking logic lives in retrieve.js; all rendering in
// brief-format.js — this module is a thin coordinator that:
//   1. resolves memory_root (arg > env > default ~/.deep-memory)
//   2. reads .deep-memory/project-profile.json (warns if absent)
//   3. calls runRetrieve() with the project profile
//   4. renders both JSON + MD via brief-format
//   5. atomic-writes latest-brief.{json,md} into the project-local .deep-memory/
//   6. prints a 1-line summary to stdout
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runRetrieve } = require('./retrieve');
const { renderJson, renderMarkdown } = require('./lib/brief-format');
const { writeJsonAtomic } = require('./lib/atomic-write');
const { projectId: deriveProjectId } = require('./init');

function resolveMemoryRoot(raw) {
  const root = raw || process.env.DEEP_MEMORY_ROOT || path.join(os.homedir(), '.deep-memory');
  return root.replace(/^~/, os.homedir());
}

function loadProjectProfile(projectDir) {
  const profilePath = path.join(projectDir, '.deep-memory', 'project-profile.json');
  if (!fs.existsSync(profilePath)) return null;
  try { return JSON.parse(fs.readFileSync(profilePath, 'utf8')); }
  catch { return null; }
}

async function run({ task, projectDir, memoryRoot, topN, diversityPerType } = {}) {
  if (!task) throw new Error('brief.run requires task');
  const cwd = projectDir || process.cwd();
  const resolvedMemoryRoot = resolveMemoryRoot(memoryRoot);
  let profile = loadProjectProfile(cwd);

  // Security guard: re-derive the expected project_id from cwd and reject a
  // profile whose stored project_id does not match — prevents project_id spoofing
  // that would expose another project's local memories (spec §privacy boundary).
  let profileMismatchWarning = null;
  if (profile) {
    const expected = deriveProjectId(cwd);
    if (profile.project_id !== expected) {
      const expectedFirst8 = expected.slice(0, 8 + 'proj_'.length);
      const gotFirst8 = String(profile.project_id || '').slice(0, 8 + 'proj_'.length);
      profileMismatchWarning =
        `project-profile mismatch: expected=${expectedFirst8} got=${gotFirst8} — using global-only retrieval`;
      profile = null; // trigger existing global-only path
    }
  }

  const result = await runRetrieve({
    task,
    memoryRoot: resolvedMemoryRoot,
    projectProfile: profile,
    topN,
    diversityPerType,
  });

  if (profileMismatchWarning) {
    result.warnings = result.warnings || [];
    result.warnings.push(profileMismatchWarning);
  }

  // Render JSON + MD
  const json = renderJson(task, result.memories);
  if (result.warnings && result.warnings.length > 0) {
    json.payload.warnings = result.warnings;
  }
  const md = renderMarkdown(task, result.memories);

  // Atomic write into project-local .deep-memory/
  const outDir = path.join(cwd, '.deep-memory');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'latest-brief.json');
  const mdPath = path.join(outDir, 'latest-brief.md');
  writeJsonAtomic(jsonPath, json);

  // MD is written via tmp+rename for atomicity (parent fsync mirrors writeJsonAtomic)
  const mdTmp = mdPath + '.tmp';
  fs.writeFileSync(mdTmp, md);
  fs.renameSync(mdTmp, mdPath);
  const dirFd = fs.openSync(outDir, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

  return {
    task,
    count: result.memories.length,
    warnings: result.warnings,
    jsonPath,
    mdPath,
  };
}

module.exports = { run, resolveMemoryRoot, loadProjectProfile };

if (require.main === module) {
  const args = process.argv.slice(2);
  const topMatch = args.find((a) => a.startsWith('--top='));
  const topN = topMatch ? Number(topMatch.split('=')[1]) : undefined;
  const taskArgs = args.filter((a) => !a.startsWith('--'));
  const task = taskArgs.join(' ');
  if (!task) {
    console.error('Usage: node scripts/brief.js "<task description>" [--top=N]');
    process.exit(1);
  }
  run({ task, topN })
    .then((r) => {
      console.log(`Brief: ${r.count} memor${r.count === 1 ? 'y' : 'ies'} retrieved for task "${r.task}"`);
      console.log(`  JSON: ${r.jsonPath}`);
      console.log(`  MD:   ${r.mdPath}`);
      if (r.warnings && r.warnings.length > 0) {
        console.log(`Warnings: ${r.warnings.length}`);
        for (const w of r.warnings) console.log(`  - ${w}`);
      }
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
