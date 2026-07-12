'use strict';
const { redactObject } = require('./redact');

function redactMcpPayload(value) {
  try {
    return redactObject(value);
  } catch {
    if (value && Array.isArray(value.contents)) {
      return {
        contents: [{
          uri: 'deep-memory://error',
          mimeType: 'application/json',
          text: '{"available":false,"reason":"output_redaction_failed"}',
        }],
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: '{"error":"output_redaction_failed"}' }],
    };
  }
}

module.exports = { redactMcpPayload };
