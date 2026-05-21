'use strict';
const { randomBytes } = require('crypto');
const { execSync } = require('child_process');

const PRODUCER = 'deep-memory';
const PRODUCER_VERSION = require('../../package.json').version;

/**
 * Generate a ULID-like identifier (lowercase alphanumeric base36 timestamp + `_` + 16 hex chars).
 * Matches the regex /^[a-z0-9]+_[a-f0-9]{16}$/ which is a subset of /^[a-z0-9_]+$/.
 */
function ulidLike() {
  return Date.now().toString(36) + '_' + randomBytes(8).toString('hex');
}

/**
 * Capture git HEAD/branch/dirty triplet, honouring the suite envelope schema constraints:
 *   - `head` MUST match /^[a-f0-9]{7,40}$/ (no `"unknown"` literal allowed).
 *   - `dirty` MUST be a boolean (or the literal string "unknown" if the enum permits).
 * Returns `null` if any git command fails or HEAD is not a valid hex SHA — the caller
 * MUST omit the `envelope.git` field in that case (better than emitting an invalid stub).
 *
 * ITEM-4-r5: accept optional `cwd` so SDK-style callers whose process.cwd() differs from
 * the project directory get the correct repo's git state. When cwd is null/undefined the
 * behaviour is identical to the previous implementation (process.cwd() default).
 */
function gitStateSafe(cwd) {
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] };
    if (cwd) opts.cwd = cwd;
    const head = execSync('git rev-parse HEAD', opts)
      .toString()
      .trim();
    if (!/^[a-f0-9]{7,40}$/.test(head)) return null; // suite schema requires hex
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts)
      .toString()
      .trim();
    const dirtyOutput = execSync('git status --porcelain', opts).toString();
    const dirty = dirtyOutput.trim().length > 0; // boolean (suite constraint)
    return { head, branch, dirty };
  } catch {
    return null; // omit git entirely if any command failed (suite constraint)
  }
}

/**
 * ITEM-4-r5: accept optional `cwd` and thread it through to gitStateSafe so that callers
 * in different process.cwd() contexts get the envelope.git fields from the intended repo.
 * Backward compat: if cwd is null/undefined, gitStateSafe uses process.cwd() as before.
 */
function wrap({ artifact_kind, schema, payload, provenance = { source_artifacts: [] }, cwd = null }) {
  const git = gitStateSafe(cwd);
  const envelope = {
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    artifact_kind,
    run_id: ulidLike(),
    generated_at: new Date().toISOString(),
    schema,
    provenance: {
      source_artifacts: provenance.source_artifacts || [],
      tool_versions: { node: process.version, ...(provenance.tool_versions || {}) },
    },
  };
  if (git) envelope.git = git; // only include when valid hex HEAD captured
  return {
    $schema: 'https://raw.githubusercontent.com/Sungmin-Cho/claude-deep-suite/main/schemas/artifact-envelope.schema.json',
    schema_version: '1.0',
    envelope,
    payload,
  };
}

module.exports = { wrap, ulidLike, gitStateSafe };
