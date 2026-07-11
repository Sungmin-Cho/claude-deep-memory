'use strict';
const fs = require('node:fs');
const { validateProjectId } = require('./validate-project-id');
const { walkContainedCards, readContainedCard } = require('./card-paths');
const { tokenize } = require('./card-filters');

const HARD_SCAN_LIMIT = 5000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function values(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? item : item && item.value))
    .filter((item) => typeof item === 'string');
}

function uniqueTokens(texts) {
  const tokens = new Set();
  for (const text of texts) {
    for (const token of tokenize(text)) tokens.add(token);
  }
  return tokens;
}

function scanCards({
  root,
  currentProjectId = null,
  query,
  topK = 30,
  io = fs,
  platform = process.platform,
} = {}) {
  if (currentProjectId !== null) validateProjectId(currentProjectId);
  const queryTokens = [...new Set(tokenize(query))];
  const warningCodes = new Set();
  let malformed = 0;
  const rows = [];

  const walked = walkContainedCards({
    root,
    currentProjectId,
    maxFiles: HARD_SCAN_LIMIT,
    io,
    platform,
    onCard(descriptor) {
      const read = readContainedCard(descriptor, { io, platform });
      if (!read.value) {
        if (read.warning === 'card_json_invalid') malformed += 1;
        else if (read.warning) warningCodes.add(read.warning);
        return;
      }
      const payload = read.value.payload || read.value;
      if (!payload || typeof payload !== 'object') {
        malformed += 1;
        return;
      }
      if (typeof payload.memory_id !== 'string' || payload.memory_id.length === 0
        || typeof payload.memory_type !== 'string' || payload.memory_type.length === 0
        || typeof payload.claim !== 'string' || payload.claim.length === 0) {
        warningCodes.add('card_shape_invalid');
        return;
      }
      if (payload.memory_type !== descriptor.type) {
        warningCodes.add('card_scope_mismatch');
        return;
      }
      const isGlobal = descriptor.scope === 'global';
      if ((isGlobal && payload.privacy_level !== 'global')
        || (!isGlobal && payload.privacy_level !== 'local')) {
        warningCodes.add('card_scope_mismatch');
        return;
      }
      if (payload.status === 'deprecated') return;

      const searchable = uniqueTokens([
        payload.claim,
        ...(Array.isArray(payload.tags) ? payload.tags : []),
        ...values(payload.applicability),
        ...(Array.isArray(payload.search_keywords) ? payload.search_keywords : []),
      ]);
      let matched = 0;
      for (const token of queryTokens) {
        if (searchable.has(token)) matched += 1;
      }
      if (queryTokens.length === 0 || matched === 0) return;
      const score = matched / queryTokens.length;
      rows.push({
        memory_id: payload.memory_id,
        memory_type: payload.memory_type,
        privacy_level: payload.privacy_level,
        project_id: isGlobal ? '' : descriptor.scope,
        claim: payload.claim,
        tags: payload.tags || [],
        applicability: payload.applicability || [],
        search_keywords: payload.search_keywords || [],
        session_id: payload.session_id,
        bm25: -score,
      });
    },
  });

  for (const warning of walked.warnings) {
    if (warning !== 'card_scan_limit_reached') warningCodes.add(warning);
  }
  const warnings = [...warningCodes].sort(compareText);
  if (malformed > 0) warnings.push(`card_json_malformed: ${malformed}`);
  if (walked.warnings.includes('card_scan_limit_reached')) {
    warnings.push(`scan_limit_reached: ${HARD_SCAN_LIMIT}`);
  }
  rows.sort((left, right) => (right.bm25 === left.bm25
    ? compareText(left.memory_id, right.memory_id)
    : left.bm25 - right.bm25));
  const limit = Number.isInteger(topK) && topK > 0 ? topK : 30;
  return {
    rows: rows.slice(0, Math.max(1, limit)),
    stream: 'card-scan',
    warnings,
  };
}

module.exports = { scanCards, HARD_SCAN_LIMIT };
