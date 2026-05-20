// scripts/lib/llm-bridge.js
//
// Cross-runtime LLM adapter bridge for Step B (sub-agent refinement) of the
// deep-memory distill pipeline. Picks an adapter via adapter-registry.detect,
// dispatches the refine call with a configurable timeout, and validates the
// adapter output against `schemas/memory-card-distill-output.schema.json`.
//
// Invariants:
//   P14 — adapter name from config/user NEVER reaches require() path arg.
//         The ADAPTERS map is a frozen allowlist; lookup-by-key only.
//   P15 — adapterOpts (recordedFixture / liveAgent / batchMode / ...) is
//         forwarded verbatim to the adapter's refine() — adapters own their
//         option vocabulary, the bridge stays neutral.
//   F5  — Step B output validates against the distill-output schema. A
//         schema violation is a typed throw (code: SCHEMA_VIOLATION) so
//         harvest can fall back to candidate (spec §7.2).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats').default || require('ajv-formats');
const { detect } = require('./adapter-registry');

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const schemaPath = path.join(__dirname, '../../schemas/memory-card-distill-output.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const validate = ajv.compile(schema);

const ADAPTERS = Object.freeze({
  'claude-agent': () => require('./adapters/claude-agent'),
  'codex-bash': () => require('./adapters/codex-bash'),
  'gemini-sdk': () => require('./adapters/gemini-sdk'),
  'stdin-fallback': () => require('./adapters/stdin-fallback'),
});

async function refine(
  eventDraft,
  sourceExcerpt,
  { adapter = 'auto', timeoutMs = 30000, ...adapterOpts } = {}
) {
  const chosen = detect(adapter);
  const loader = ADAPTERS[chosen];
  if (!loader) {
    throw Object.assign(
      new Error(`Unknown adapter '${chosen}'. Allowed: ${Object.keys(ADAPTERS).join(', ')}`),
      { code: 'UNKNOWN_ADAPTER' }
    );
  }
  const mod = loader();

  let timer;
  const timeoutPromise = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(Object.assign(
        new Error(`LLM bridge timeout (${chosen}, ${timeoutMs}ms)`),
        { code: 'TIMEOUT' }
      )),
      timeoutMs
    );
  });

  let out;
  try {
    out = await Promise.race([mod.refine(eventDraft, sourceExcerpt, adapterOpts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  if (!validate(out)) {
    throw Object.assign(
      new Error(`Step B output schema violation: ${ajv.errorsText(validate.errors)}`),
      { code: 'SCHEMA_VIOLATION', errors: validate.errors }
    );
  }
  return out;
}

module.exports = { refine, ADAPTER_NAMES: Object.keys(ADAPTERS) };
