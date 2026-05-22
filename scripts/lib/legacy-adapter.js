'use strict';
// scripts/lib/legacy-adapter.js
// PR1-F (R4-H): wrap v0.1.x flat event records into v0.3.0 M3 envelope
// shape at READ TIME. No disk migration — the legacy file stays as-is;
// readers route flat records through this adapter before validation.
// All synthesized fields are deterministic (re-running wrap on the same
// input produces byte-identical output).

const crypto = require('node:crypto');

/**
 * Wrap a v0.1.x flat event record into the memory-event envelope/payload shape.
 * @param {object} flat - flat record with at minimum {event_key, at, cards_count}.
 * @returns {object} envelope/payload-wrapped record valid against memory-event.schema.json.
 */
function wrapLegacy(flat) {
  // PR1-F: producer_version must satisfy SemVer pattern `^\d+\.\d+\.\d+$`.
  // Real legacy events came from v0.1.0/0.1.1/0.1.2/0.1.3. We can't recover
  // the exact origin version from a flat record; default to "0.1.0".
  const producerVersion = '0.1.0';

  // PR1-F: event_key must satisfy `^[a-f0-9]{64}$`. Legacy event_key was
  // shorter (no fixed format). Normalize by sha256-hashing the original key
  // concatenated with `at`. If already 64-hex lowercase, pass through.
  const eventKey = /^[a-f0-9]{64}$/.test(flat.event_key)
    ? flat.event_key
    : crypto.createHash('sha256').update(`${flat.event_key}|${flat.at}`).digest('hex');

  // PR1-F: real v0.1.x `source` can be either a string (early fixture pattern)
  // OR an object `{adapter_id, path, content_hash, captured_at}` (per real
  // scripts/harvest.js output). Handle both.
  let sourcePath;
  if (typeof flat.source === 'string') {
    sourcePath = flat.source;
  } else if (flat.source && typeof flat.source.path === 'string') {
    sourcePath = flat.source.path;
  } else {
    sourcePath = 'legacy';
  }

  return {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-memory',
      producer_version: producerVersion,
      artifact_kind: 'memory-event',
      run_id: flat.run_id || '0',
      generated_at: flat.at,
      schema: { name: 'memory-event', version: '1.0' },
      git: { head: '', branch: '', dirty: 'unknown' },
      provenance: { source_artifacts: [{ path: sourcePath }] }
    },
    payload: {
      event_key: eventKey,
      source_artifact_id: 'src_1',     // adapter default
      event_kind: 'harvested',          // legacy was always harvest-result
      cards_count: flat.cards_count || 0,
      at: flat.at
    }
  };
}

module.exports = { wrapLegacy };
