// scripts/lib/brief-format.js
//
// Render retrieved memory cards as a structured brief in two formats:
//   - JSON: machine-readable, full payload preserved + per-memory why_relevant/score
//   - Markdown: human-readable summary suitable for terminal display
//
// F2 fallback rule (spec §9.2): when a card lacks LLM-derived fields, the brief
// substitutes per-card defaults rather than emitting empty strings (which would
// look like a render bug). This keeps the brief stable across Step B successes
// and fallbacks.
'use strict';
const { wrap } = require('./envelope');

const DEFAULTS = Object.freeze({
  why_relevant: '(retrieved by lexical match)',
  avoid_when: '(none specified)',
  recommended_action: '(none — refer to evidence)',
});

function defaultedAvoidWhen(card) {
  const non = card.payload?.non_applicability || [];
  const values = non.map((n) => n.value).filter(Boolean);
  return values.length > 0 ? values : [DEFAULTS.avoid_when];
}

function defaultedRecommendedAction(card) {
  const action = card.payload?.recommended_action || [];
  return action.length > 0 ? action : [DEFAULTS.recommended_action];
}

function defaultedWhyRelevant(card, fallback = DEFAULTS.why_relevant) {
  if (card.why_relevant && card.why_relevant.length > 0) return card.why_relevant;
  return fallback;
}

function renderMemory(card, extra = {}) {
  const p = card.payload || {};
  const provenance = card.envelope?.provenance?.source_artifacts || [];
  return {
    memory_id: p.memory_id,
    memory_type: p.memory_type,
    score: typeof card.score === 'number' ? card.score : (typeof extra.score === 'number' ? extra.score : 0),
    claim: p.claim,
    why_relevant: defaultedWhyRelevant(card, extra.why_relevant),
    avoid_when: defaultedAvoidWhen(card),
    recommended_action: defaultedRecommendedAction(card),
    evidence: provenance.map((s) => s.path).filter(Boolean),
    tags: p.tags || [],
    privacy_level: p.privacy_level,
    confidence: p.confidence,
  };
}

/**
 * Render the full brief as a wrapped M3 envelope artifact. The brief lives under
 * `.deep-memory/latest-brief.json` (project-local) so other deep-suite plugins
 * can consume it post-retrieve without re-running the ranking pipeline.
 *
 * Accepts a single card + extra fields (used by per-card unit tests) OR a list
 * of cards (production path). The single-card overload is a convenience for
 * brief-format.test.js — production always passes the array.
 */
// ITEM-4-r5: accept optional cwd and thread to wrap so gitStateSafe in envelope.js
// captures the correct repo's git state when called from a different process.cwd().
// Backward compat: cwd defaults to null → gitStateSafe uses process.cwd() as before.
function renderJson(task, cardsOrCard, extra = {}, cwd = null) {
  const cards = Array.isArray(cardsOrCard) ? cardsOrCard : [cardsOrCard];
  const memories = cards.map((c) => renderMemory(c, extra));
  return wrap({
    artifact_kind: 'memory-brief',
    schema: { name: 'memory-brief', version: '1.0' },
    payload: {
      task,
      generated_at: new Date().toISOString(),
      count: memories.length,
      memories,
    },
    provenance: { source_artifacts: [] },
    cwd,
  });
}

function renderMarkdown(task, cardsOrCard, extra = {}) {
  const cards = Array.isArray(cardsOrCard) ? cardsOrCard : [cardsOrCard];
  if (cards.length === 0) {
    return [
      `# Deep-Memory Brief — ${task}`,
      '',
      'No memories yet — run `/deep-memory-harvest` first or broaden the task wording.',
      '',
    ].join('\n');
  }
  const lines = [];
  lines.push(`# Deep-Memory Brief — ${task}`);
  lines.push('');
  lines.push(`_${cards.length} memor${cards.length === 1 ? 'y' : 'ies'} retrieved_`);
  lines.push('');
  let idx = 0;
  for (const card of cards) {
    idx += 1;
    const m = renderMemory(card, extra);
    lines.push(`## ${idx}. ${m.memory_type} — \`${m.memory_id}\` (score ${m.score.toFixed(3)})`);
    lines.push('');
    lines.push(`**Claim:** ${m.claim}`);
    lines.push('');
    lines.push(`**Why relevant:** ${m.why_relevant}`);
    lines.push('');
    lines.push('**Avoid when:**');
    for (const av of m.avoid_when) lines.push(`- ${av}`);
    lines.push('');
    lines.push('**Recommended action:**');
    for (const ra of m.recommended_action) lines.push(`- ${ra}`);
    lines.push('');
    if (m.evidence.length > 0) {
      lines.push('**Evidence:**');
      for (const ev of m.evidence) lines.push(`- ${ev}`);
      lines.push('');
    }
    if (m.tags.length > 0) {
      lines.push(`**Tags:** ${m.tags.map((t) => '`' + t + '`').join(' ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

module.exports = {
  renderJson,
  renderMarkdown,
  renderMemory,
  defaultedAvoidWhen,
  defaultedRecommendedAction,
  defaultedWhyRelevant,
  DEFAULTS,
};
