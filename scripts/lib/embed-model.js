'use strict';
// scripts/lib/embed-model.js
// γ.3 — @xenova/transformers lazy loader with PR2-E widened catch and
// R3-G + R4-I model-version mismatch handling.

const fs = require('node:fs');
const path = require('node:path');

let modelCache = null;
let loadAttempted = false;

const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;

async function loadModel() {
  if (modelCache) return modelCache;
  if (loadAttempted && modelCache === null) return null;  // already failed once
  loadAttempted = true;
  try {
    // Dynamic import — @xenova is ESM-only.
    const { pipeline } = await import('@xenova/transformers');
    modelCache = await pipeline('feature-extraction', EMBED_MODEL_ID);
    return modelCache;
  } catch (e) {
    // PR2-E + R4-I — widened catch. Any load-time error (MODULE_NOT_FOUND,
    // ERR_MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED, native init
    // failures from onnxruntime-node, runtime model fetch errors, ...) →
    // graceful FTS5-only fallback.
    if (process.env.DEBUG_EMBED) {
      console.warn(`[deep-memory] embedding model unavailable: ${e.message}; falling back to FTS5-only retrieval`);
    }
    return null;
  }
}

function loadedModelVersion() {
  try {
    const pkg = require('@xenova/transformers/package.json');
    return `${pkg.version}@${EMBED_MODEL_ID}`;
  } catch {
    return null;
  }
}

function readStoredModelVersion(root) {
  const p = path.join(root, '.embed-model-version');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function writeStoredModelVersion(root, version) {
  const p = path.join(root, '.embed-model-version');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, version + '\n');
}

/**
 * Probe model version + compare against stored. Returns:
 *   { status: 'ok'        | 'absent' | 'mismatch' | 'first-time',
 *     loaded?: string, stored?: string }
 */
function probeModelVersion(root) {
  const loaded = loadedModelVersion();
  if (!loaded) return { status: 'absent' };
  const stored = readStoredModelVersion(root);
  if (!stored) return { status: 'first-time', loaded };
  if (stored !== loaded) return { status: 'mismatch', loaded, stored };
  return { status: 'ok', loaded, stored };
}

async function embedText(text) {
  const model = await loadModel();
  if (!model) return null;  // FTS5-only path
  const output = await model(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length EMBED_DIM
  return Float32Array.from(output.data);
}

module.exports = {
  loadModel,
  loadedModelVersion,
  readStoredModelVersion,
  writeStoredModelVersion,
  probeModelVersion,
  embedText,
  EMBED_MODEL_ID,
  EMBED_DIM
};
