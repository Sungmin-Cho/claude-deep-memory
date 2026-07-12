'use strict';
const schemas = Object.freeze({
  'audit-log-entry': Object.freeze(require('../../schemas/audit-log-entry.schema.json')),
  'memory-card': Object.freeze(require('../../schemas/memory-card.schema.json')),
  'memory-card-distill-output': Object.freeze(require('../../schemas/memory-card-distill-output.schema.json')),
  'memory-event': Object.freeze(require('../../schemas/memory-event.schema.json')),
  'memory-hook-event': Object.freeze(require('../../schemas/memory-hook-event.schema.json')),
  'project-profile': require('./project-profile-validator').PROJECT_PROFILE_SCHEMA,
});

function getSchema(name) {
  if (!Object.hasOwn(schemas, name)) {
    throw Object.assign(new Error(`Unknown schema: ${name}`), { code: 'UNKNOWN_SCHEMA' });
  }
  return schemas[name];
}

module.exports = { getSchema, SCHEMA_NAMES: Object.freeze(Object.keys(schemas)) };
