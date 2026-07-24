'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outdir = path.join(root, 'dist', 'hooks');
const entryPoints = Object.freeze({
  'session-start': path.join(root, 'scripts', 'hooks', 'session-start.mjs'),
  'user-prompt-submit': path.join(root, 'scripts', 'hooks', 'user-prompt-submit.mjs'),
  'post-tool-use': path.join(root, 'scripts', 'hooks', 'post-tool-use.mjs'),
  'post-tool-failure': path.join(root, 'scripts', 'hooks', 'post-tool-failure.mjs'),
  'pre-compact': path.join(root, 'scripts', 'hooks', 'pre-compact.mjs'),
  'session-end': path.join(root, 'scripts', 'hooks', 'session-end.mjs'),
});

fs.mkdirSync(outdir, { recursive: true });
esbuild.buildSync({
  entryPoints,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outExtension: { '.js': '.cjs' },
  entryNames: '[name]',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
});

for (const name of Object.keys(entryPoints)) {
  const output = path.join(outdir, `${name}.cjs`);
  const source = fs.readFileSync(output, 'utf8');
  const normalized = source.replace(/[ \t]+$/gm, '');
  if (normalized !== source) fs.writeFileSync(output, normalized);
}
