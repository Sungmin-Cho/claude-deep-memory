'use strict';
const Ajv2020 = require('ajv/dist/2020').default;
const addFormatsModule = require('ajv-formats');
const addFormats = addFormatsModule.default || addFormatsModule;
const schema = require('../../schemas/project-profile.schema.json');

const PROJECT_PROFILE_SCHEMA = Object.freeze(schema);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(PROJECT_PROFILE_SCHEMA);

function validateProjectProfile(profile) {
  if (!validate(profile)) {
    return { valid: false, reason: 'project_profile_schema_invalid' };
  }
  return { valid: true, profile };
}

module.exports = { PROJECT_PROFILE_SCHEMA, validateProjectProfile };
