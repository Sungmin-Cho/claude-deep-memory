'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isValidProjectId } = require('./validate-project-id');

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function isContainedPath(parent, child, { platform = process.platform } = {}) {
  const api = pathApi(platform);
  let base = api.resolve(parent);
  let candidate = api.resolve(child);
  if (platform === 'win32') {
    base = base.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  return candidate.startsWith(`${base}${api.sep}`);
}

function realpathNative(io, value) {
  const impl = io.realpathSync && (io.realpathSync.native || io.realpathSync);
  if (typeof impl !== 'function') throw Object.assign(new Error('realpath unavailable'), { code: 'ENOSYS' });
  return impl.call(io.realpathSync, value);
}

function isLink(stat) {
  return Boolean(stat && typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink());
}

function safeName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && path.basename(value) === value
    && !value.includes('/')
    && !value.includes('\\');
}

function addWarning(state, code) {
  state.warnings.add(code);
}

function lstatDirectory(io, lexical, parentPhysical, state, { missingIsClean = false } = {}) {
  let stat;
  try { stat = io.lstatSync(lexical); }
  catch (error) {
    if (!(missingIsClean && error && error.code === 'ENOENT')) addWarning(state, 'card_path_unavailable');
    return null;
  }
  if (isLink(stat)) {
    addWarning(state, 'card_path_link_rejected');
    return null;
  }
  if (!stat.isDirectory()) {
    addWarning(state, 'card_path_not_directory');
    return null;
  }
  let physical;
  try { physical = realpathNative(io, lexical); }
  catch {
    addWarning(state, 'card_path_unavailable');
    return null;
  }
  if (parentPhysical && !isContainedPath(parentPhysical, physical, { platform: state.platform })) {
    addWarning(state, 'card_path_outside_scope');
    return null;
  }
  return physical;
}

function resolveRootAndCards(root, io, state) {
  const rootLexical = path.resolve(root);
  const rootPhysical = lstatDirectory(io, rootLexical, null, state);
  if (!rootPhysical) return null;
  const cardsLexical = path.join(rootPhysical, 'cards');
  const cardsPhysical = lstatDirectory(io, cardsLexical, rootPhysical, state, { missingIsClean: true });
  if (!cardsPhysical) return null;
  return { rootPhysical, cardsPhysical };
}

function resolveTypeAndScope({ root, type, scope, currentProjectId, io, state }) {
  if (!safeName(type)) {
    addWarning(state, 'card_path_outside_scope');
    return null;
  }
  if (scope !== 'global' && scope !== currentProjectId) {
    addWarning(state, 'project_scope_invalid');
    return null;
  }
  const base = resolveRootAndCards(root, io, state);
  if (!base) return null;
  const typeLexical = path.join(base.cardsPhysical, type);
  const typePhysical = lstatDirectory(io, typeLexical, base.cardsPhysical, state, { missingIsClean: true });
  if (!typePhysical) return null;
  const scopeLexical = path.join(typePhysical, scope);
  const scopePhysical = lstatDirectory(io, scopeLexical, typePhysical, state, { missingIsClean: true });
  if (!scopePhysical) return null;
  return { ...base, typePhysical, scopePhysical };
}

function finalize(state, visited) {
  return { visited, warnings: [...state.warnings].sort() };
}

function walkContainedCards({
  root,
  currentProjectId = null,
  maxFiles = 5000,
  onCard,
  io = fs,
  platform = process.platform,
} = {}) {
  const state = { platform, warnings: new Set() };
  if (currentProjectId !== null && !isValidProjectId(currentProjectId)) {
    addWarning(state, 'project_scope_invalid');
    return finalize(state, 0);
  }
  if (typeof onCard !== 'function') throw new TypeError('walkContainedCards requires onCard');
  const boundedMax = Number.isInteger(maxFiles) && maxFiles > 0 ? Math.min(maxFiles, 5000) : 5000;
  const base = resolveRootAndCards(root, io, state);
  if (!base) return finalize(state, 0);
  let entries;
  try { entries = io.readdirSync(base.cardsPhysical, { withFileTypes: true }); }
  catch {
    addWarning(state, 'card_path_unavailable');
    return finalize(state, 0);
  }
  let visited = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!safeName(entry.name)) {
      addWarning(state, 'card_path_outside_scope');
      continue;
    }
    const typeLexical = path.join(base.cardsPhysical, entry.name);
    const typePhysical = lstatDirectory(io, typeLexical, base.cardsPhysical, state, { missingIsClean: true });
    if (!typePhysical) continue;
    const scopes = currentProjectId === null ? ['global'] : ['global', currentProjectId];
    for (const scope of scopes) {
      const scopeLexical = path.join(typePhysical, scope);
      const scopePhysical = lstatDirectory(io, scopeLexical, typePhysical, state, { missingIsClean: true });
      if (!scopePhysical) continue;
      let files;
      try { files = io.readdirSync(scopePhysical, { withFileTypes: true }); }
      catch {
        addWarning(state, 'card_path_unavailable');
        continue;
      }
      for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
        if (!safeName(file.name) || !file.name.endsWith('.json')) continue;
        if (visited >= boundedMax) {
          addWarning(state, 'card_scan_limit_reached');
          return finalize(state, visited);
        }
        const fileLexical = path.join(scopePhysical, file.name);
        let stat;
        try { stat = io.lstatSync(fileLexical); }
        catch {
          addWarning(state, 'card_path_unavailable');
          continue;
        }
        if (isLink(stat)) {
          addWarning(state, 'card_path_link_rejected');
          continue;
        }
        if (!stat.isFile()) {
          addWarning(state, 'card_path_not_regular');
          continue;
        }
        let filePhysical;
        try { filePhysical = realpathNative(io, fileLexical); }
        catch {
          addWarning(state, 'card_path_unavailable');
          continue;
        }
        if (!isContainedPath(scopePhysical, filePhysical, { platform })) {
          addWarning(state, 'card_path_outside_scope');
          continue;
        }
        onCard(Object.freeze({
          root: base.rootPhysical,
          currentProjectId,
          type: entry.name,
          scope,
          file: file.name,
          path: filePhysical,
        }));
        visited += 1;
      }
    }
  }
  return finalize(state, visited);
}

function readContainedCard(descriptor, { io = fs, platform = process.platform } = {}) {
  const state = { platform, warnings: new Set() };
  if (!descriptor || typeof descriptor !== 'object') {
    return { value: null, warning: 'card_path_invalid_descriptor' };
  }
  const { root, currentProjectId = null, type, scope, file } = descriptor;
  if (currentProjectId !== null && !isValidProjectId(currentProjectId)) {
    return { value: null, warning: 'project_scope_invalid' };
  }
  if (!safeName(file) || !file.endsWith('.json')) {
    return { value: null, warning: 'card_path_invalid_descriptor' };
  }
  const chain = resolveTypeAndScope({ root, type, scope, currentProjectId, io, state });
  if (!chain) return { value: null, warning: [...state.warnings].sort()[0] || 'card_path_unavailable' };
  const lexical = path.join(chain.scopePhysical, file);
  let stat;
  try { stat = io.lstatSync(lexical); }
  catch { return { value: null, warning: 'card_path_unavailable' }; }
  if (isLink(stat)) return { value: null, warning: 'card_path_link_rejected' };
  if (!stat.isFile()) return { value: null, warning: 'card_path_not_regular' };
  let physical;
  try { physical = realpathNative(io, lexical); }
  catch { return { value: null, warning: 'card_path_unavailable' }; }
  if (!isContainedPath(chain.scopePhysical, physical, { platform })) {
    return { value: null, warning: 'card_path_outside_scope' };
  }
  if (descriptor.path && path.resolve(descriptor.path) !== path.resolve(physical)) {
    return { value: null, warning: 'card_path_outside_scope' };
  }
  try { return { value: JSON.parse(io.readFileSync(physical, 'utf8')), warning: null }; }
  catch { return { value: null, warning: 'card_json_invalid' }; }
}

module.exports = { isContainedPath, walkContainedCards, readContainedCard };
