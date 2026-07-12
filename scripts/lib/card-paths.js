'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./atomic-write');
const { isValidProjectId } = require('./validate-project-id');

const MAX_CARD_FILES = 5000;

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

function samePath(left, right, platform) {
  const api = pathApi(platform);
  let a = api.resolve(left);
  let b = api.resolve(right);
  if (platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b;
}

function createCardFilesystemBudget(limit = MAX_CARD_FILES) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('card filesystem budget must be positive');
  return { limit, used: 0, exhausted: false };
}

function consumeBudget(budget) {
  if (!budget) return;
  if (budget.used >= budget.limit) {
    budget.exhausted = true;
    throw Object.assign(new Error('card filesystem budget exhausted'), { code: 'CARD_FILESYSTEM_BUDGET_EXHAUSTED' });
  }
  budget.used += 1;
}

function budgetedIo(io, budget) {
  if (!budget) return io;
  const wrapped = Object.create(io);
  for (const name of ['lstatSync', 'readdirSync', 'readFileSync']) {
    wrapped[name] = (...args) => {
      consumeBudget(budget);
      return Reflect.apply(io[name], io, args);
    };
  }
  const realpathImpl = (...args) => {
    consumeBudget(budget);
    const impl = io.realpathSync && (io.realpathSync.native || io.realpathSync);
    return Reflect.apply(impl, io.realpathSync, args);
  };
  wrapped.realpathSync = Object.assign((...args) => realpathImpl(...args), {
    native: (...args) => realpathImpl(...args),
  });
  return wrapped;
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

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lstatDirectory(io, lexical, parentPhysical, state, { missingIsClean = false } = {}) {
  let stat;
  try { stat = io.lstatSync(lexical); }
  catch (error) {
    if (error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED') addWarning(state, 'card_filesystem_budget_exhausted');
    else if (!(missingIsClean && error && error.code === 'ENOENT')) addWarning(state, 'card_path_unavailable');
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
  catch (error) {
    addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
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

function walkContainedCardsInternal({
  root,
  currentProjectId = null,
  maxFiles = MAX_CARD_FILES,
  onCard,
  io = fs,
  platform = process.platform,
  budget = null,
} = {}, { exhaustive = false } = {}) {
  const state = { platform, warnings: new Set() };
  io = budgetedIo(io, budget);
  if (currentProjectId !== null && !isValidProjectId(currentProjectId)) {
    addWarning(state, 'project_scope_invalid');
    return finalize(state, 0);
  }
  if (typeof onCard !== 'function') throw new TypeError('walkContainedCards requires onCard');
  const boundedMax = exhaustive
    ? null
    : (Number.isInteger(maxFiles) && maxFiles > 0 ? Math.min(maxFiles, MAX_CARD_FILES) : MAX_CARD_FILES);
  const base = resolveRootAndCards(root, io, state);
  if (!base) return finalize(state, 0);
  let entries;
  try { entries = io.readdirSync(base.cardsPhysical, { withFileTypes: true }); }
  catch (error) {
    addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
    return finalize(state, 0);
  }
  let visited = 0;
  for (const entry of [...entries].sort((a, b) => lexicalCompare(a.name, b.name))) {
    if (!safeName(entry.name)) {
      addWarning(state, 'card_path_outside_scope');
      continue;
    }
    const typeLexical = path.join(base.cardsPhysical, entry.name);
    const typePhysical = lstatDirectory(io, typeLexical, base.cardsPhysical, state, { missingIsClean: true });
    if (!typePhysical) continue;
    const scopes = (currentProjectId === null ? ['global'] : ['global', currentProjectId]).sort(lexicalCompare);
    for (const scope of scopes) {
      const scopeLexical = path.join(typePhysical, scope);
      const scopePhysical = lstatDirectory(io, scopeLexical, typePhysical, state, { missingIsClean: true });
      if (!scopePhysical) continue;
      let files;
      try { files = io.readdirSync(scopePhysical, { withFileTypes: true }); }
      catch (error) {
        addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
          ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
        continue;
      }
      for (const file of [...files].sort((a, b) => lexicalCompare(a.name, b.name))) {
        if (!safeName(file.name) || !file.name.endsWith('.json')) continue;
        if (boundedMax !== null && visited >= boundedMax) {
          addWarning(state, 'card_scan_limit_reached');
          return finalize(state, visited);
        }
        const fileLexical = path.join(scopePhysical, file.name);
        let stat;
        try { stat = io.lstatSync(fileLexical); }
        catch (error) {
          addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
            ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
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
        catch (error) {
          addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
            ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
          continue;
        }
        if (!isContainedPath(scopePhysical, filePhysical, { platform })) {
          addWarning(state, 'card_path_outside_scope');
          continue;
        }
        const shouldContinue = onCard(Object.freeze({
          root: base.rootPhysical,
          currentProjectId,
          type: entry.name,
          scope,
          file: file.name,
          path: filePhysical,
        }));
        visited += 1;
        if (shouldContinue === false) return finalize(state, visited);
      }
    }
  }
  return finalize(state, visited);
}

// Retrieval fallback stays hard-bounded. Audit and mutation callers use the
// exhaustive sibling so they never publish or act on a silently truncated set.
function walkContainedCards(options = {}) {
  return walkContainedCardsInternal(options);
}

function walkAllContainedCards(options = {}) {
  return walkContainedCardsInternal(options, { exhaustive: true });
}

function walkContainedCardTypes({
  root, onType, io = fs, platform = process.platform, budget = null,
} = {}) {
  const state = { platform, warnings: new Set() };
  io = budgetedIo(io, budget);
  if (typeof onType !== 'function') throw new TypeError('walkContainedCardTypes requires onType');
  const base = resolveRootAndCards(root, io, state);
  if (!base) return finalize(state, 0);
  let entries;
  try { entries = io.readdirSync(base.cardsPhysical, { withFileTypes: true }); }
  catch (error) {
    addWarning(state, error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable');
    return finalize(state, 0);
  }
  let visited = 0;
  for (const entry of [...entries].sort((a, b) => lexicalCompare(a.name, b.name))) {
    if (!safeName(entry.name)) continue;
    const typePhysical = lstatDirectory(
      io, path.join(base.cardsPhysical, entry.name), base.cardsPhysical, state, { missingIsClean: true },
    );
    if (!typePhysical) continue;
    visited += 1;
    if (onType(Object.freeze({ root: base.rootPhysical, type: entry.name, path: typePhysical })) === false) break;
  }
  return finalize(state, visited);
}

function descriptorState(descriptor, { io = fs, platform = process.platform, budget = null } = {}) {
  const state = { platform, warnings: new Set() };
  if (!descriptor || typeof descriptor !== 'object') return { warning: 'card_path_invalid_descriptor' };
  const { root, currentProjectId = null, type, scope, file } = descriptor;
  if (currentProjectId !== null && !isValidProjectId(currentProjectId)) return { warning: 'project_scope_invalid' };
  if (!safeName(file) || !file.endsWith('.json')) return { warning: 'card_path_invalid_descriptor' };
  const boundedIo = budgetedIo(io, budget);
  const chain = resolveTypeAndScope({ root, type, scope, currentProjectId, io: boundedIo, state });
  if (!chain) return { warning: [...state.warnings].sort()[0] || 'card_path_unavailable' };
  return { state, io: boundedIo, chain, lexical: path.join(chain.scopePhysical, file) };
}

function readContainedCard(descriptor, options = {}) {
  const resolved = descriptorState(descriptor, options);
  if (resolved.warning) return { value: null, warning: resolved.warning };
  const { io, chain, lexical, state } = resolved;
  let stat;
  try { stat = io.lstatSync(lexical); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { value: null, warning: null, missing: true };
    return { value: null, warning: error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable' };
  }
  if (isLink(stat)) return { value: null, warning: 'card_path_link_rejected' };
  if (!stat.isFile()) return { value: null, warning: 'card_path_not_regular' };
  let physical;
  try { physical = realpathNative(io, lexical); }
  catch (error) {
    return { value: null, warning: error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_path_unavailable' };
  }
  if (!isContainedPath(chain.scopePhysical, physical, { platform: state.platform })) {
    return { value: null, warning: 'card_path_outside_scope' };
  }
  if (descriptor.path && !samePath(descriptor.path, physical, state.platform)) {
    return { value: null, warning: 'card_path_outside_scope' };
  }
  try { return { value: JSON.parse(io.readFileSync(physical, 'utf8')), warning: null, path: physical }; }
  catch (error) {
    return { value: null, warning: error && error.code === 'CARD_FILESYSTEM_BUDGET_EXHAUSTED'
      ? 'card_filesystem_budget_exhausted' : 'card_json_invalid' };
  }
}

function unsafeError(warning) {
  return Object.assign(new Error(`unsafe card path: ${warning}`), { code: 'CARD_PATH_UNSAFE', warning });
}

function ensureContainedDirectory(lexical, parentPhysical, state) {
  let physical = lstatDirectory(fs, lexical, parentPhysical, state, { missingIsClean: true });
  if (physical) return physical;
  if (state.warnings.size > 0) return null;
  try { fs.mkdirSync(lexical); }
  catch (error) {
    if (!error || error.code !== 'EEXIST') {
      addWarning(state, 'card_path_unavailable');
      return null;
    }
  }
  return lstatDirectory(fs, lexical, parentPhysical, state);
}

function resolveMutationChain(descriptor, { createDirectories = false, platform = process.platform } = {}) {
  const state = { platform, warnings: new Set() };
  if (!descriptor || typeof descriptor !== 'object') return { warning: 'card_path_invalid_descriptor' };
  const { root, currentProjectId = null, type, scope, file } = descriptor;
  if (currentProjectId !== null && !isValidProjectId(currentProjectId)) return { warning: 'project_scope_invalid' };
  if (!safeName(type) || !safeName(file) || !file.endsWith('.json')) return { warning: 'card_path_invalid_descriptor' };
  if (scope !== 'global' && scope !== currentProjectId) return { warning: 'project_scope_invalid' };
  const rootPhysical = lstatDirectory(fs, path.resolve(root), null, state);
  if (!rootPhysical) return { warning: [...state.warnings][0] || 'card_path_unavailable' };
  let parent = rootPhysical;
  for (const name of ['cards', type, scope]) {
    const lexical = path.join(parent, name);
    const physical = createDirectories
      ? ensureContainedDirectory(lexical, parent, state)
      : lstatDirectory(fs, lexical, parent, state, { missingIsClean: true });
    if (!physical) return {
      warning: [...state.warnings][0] || null,
      missing: state.warnings.size === 0,
    };
    parent = physical;
  }
  return { state, scopePhysical: parent, lexical: path.join(parent, file) };
}

// Shared mutation boundary. The full root -> cards -> type -> exact scope ->
// file chain is lstat/realpath-validated immediately before each operation.
function mutateContainedCard(descriptor, {
  action, value, createDirectories = false, platform = process.platform,
} = {}) {
  if (!['probe', 'read', 'write', 'unlink'].includes(action)) throw new TypeError('invalid contained card action');
  const resolved = resolveMutationChain(descriptor, { createDirectories, platform });
  if (resolved.warning) throw unsafeError(resolved.warning);
  if (resolved.missing) {
    if (action === 'write' && createDirectories) throw unsafeError('card_path_unavailable');
    return { exists: false, value: null, path: null };
  }
  const { scopePhysical, lexical } = resolved;
  let stat = null;
  try { stat = fs.lstatSync(lexical); }
  catch (error) {
    if (!error || error.code !== 'ENOENT') throw unsafeError('card_path_unavailable');
  }
  if (stat) {
    if (isLink(stat)) throw unsafeError('card_path_link_rejected');
    if (!stat.isFile()) throw unsafeError('card_path_not_regular');
    let physical;
    try { physical = fs.realpathSync.native(lexical); }
    catch { throw unsafeError('card_path_unavailable'); }
    if (!isContainedPath(scopePhysical, physical, { platform })) throw unsafeError('card_path_outside_scope');
    if (descriptor.path && !samePath(descriptor.path, physical, platform)) throw unsafeError('card_path_outside_scope');
    if (action === 'probe') return { exists: true, value: null, path: physical };
    if (action === 'read') {
      let source;
      try { source = fs.readFileSync(physical, 'utf8'); }
      catch { throw unsafeError('card_path_unavailable'); }
      try { return { exists: true, value: JSON.parse(source), path: physical }; }
      catch { throw unsafeError('card_json_invalid'); }
    }
    if (action === 'unlink') {
      fs.unlinkSync(physical);
      return { exists: false, value: null, path: physical };
    }
    writeJsonAtomic(physical, value);
    return { exists: true, value, path: physical };
  }
  if (action !== 'write') return { exists: false, value: null, path: lexical };
  writeJsonAtomic(lexical, value);
  return { exists: true, value, path: lexical };
}

function writeContainedCard(descriptor, value, options = {}) {
  return mutateContainedCard(descriptor, { ...options, action: 'write', value, createDirectories: true });
}

function unlinkContainedCard(descriptor, options = {}) {
  return mutateContainedCard(descriptor, { ...options, action: 'unlink' });
}

module.exports = {
  MAX_CARD_FILES,
  isContainedPath,
  createCardFilesystemBudget,
  walkContainedCards,
  walkAllContainedCards,
  walkContainedCardTypes,
  readContainedCard,
  mutateContainedCard,
  writeContainedCard,
  unlinkContainedCard,
};
