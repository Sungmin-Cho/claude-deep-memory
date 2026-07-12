'use strict';
// scripts/lib/event-dispatcher.js
// α.11 + R4-H: artifact_kind dispatcher for events/YYYY-MM.jsonl.
//
// Routes one JSONL line to the correct validator:
//   - {schema_version, envelope, payload} + artifact_kind: 'memory-event'
//       → memory-event.schema.json (v0.1.x state-machine events)
//   - {schema_version, envelope, payload} + artifact_kind: 'memory-hook-event'
//       → memory-hook-event.schema.json (v0.3.0 hook capture events)
//   - Flat shape with {event_key, at, cards_count} → wrap via legacy-adapter
//     then validate against memory-event.schema.json (R4-H backward-compat)
//   - Anything else → quarantine
//
// Validator instances are constructed lazily once per process.

const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const { wrapLegacy } = require('./legacy-adapter');
const { getSchema } = require('./schema-registry');

let _validateEvent = null;
let _validateHook = null;

function getEventValidator() {
  if (_validateEvent) return _validateEvent;
  const schema = getSchema('memory-event');
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  _validateEvent = ajv.compile(schema);
  return _validateEvent;
}

function getHookValidator() {
  if (_validateHook) return _validateHook;
  const schema = getSchema('memory-hook-event');
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  _validateHook = ajv.compile(schema);
  return _validateHook;
}

/**
 * Route one JSONL line to the correct validator.
 * @param {string} line - one line from events/YYYY-MM.jsonl
 * @returns {{routed: string, valid?: boolean, errors?: object, reason?: string}}
 */
function dispatch(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { routed: 'quarantine', reason: 'unparseable' };
  }
  if (obj && obj.envelope && obj.payload) {
    if (obj.envelope.artifact_kind === 'memory-event') {
      const v = getEventValidator();
      return { routed: 'memory-event', valid: v(obj), errors: v.errors };
    }
    if (obj.envelope.artifact_kind === 'memory-hook-event') {
      const v = getHookValidator();
      return { routed: 'memory-hook-event', valid: v(obj), errors: v.errors };
    }
    return { routed: 'quarantine', reason: 'unknown-artifact-kind' };
  }
  // R4-H legacy flat shape: {event_key, at, cards_count} (matches real v0.1.x
  // harvest.js output; see fixtures/legacy/v01x-flat-event.jsonl).
  if (obj && obj.event_key && obj.at && typeof obj.cards_count !== 'undefined') {
    const wrapped = wrapLegacy(obj);
    const v = getEventValidator();
    return { routed: 'memory-event-legacy-wrapped', valid: v(wrapped), errors: v.errors };
  }
  return { routed: 'quarantine', reason: 'unknown-shape' };
}

module.exports = { dispatch };
