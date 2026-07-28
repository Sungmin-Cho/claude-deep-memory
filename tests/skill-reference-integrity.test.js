'use strict';

// Reference integrity for skills/ and agents/ markdown.
//
// Ported from deep-work's guard of the same name. The blast radius here is
// wider than in a build-only plugin: deep-memory reads and writes durable user
// memory under ~/.deep-memory, so an instruction shadowed by the workspace can
// steer what gets harvested, distilled, promoted to `global`, or exported.
//
// Fence balance is checked because a `references/` split once truncated a
// fenced template mid-block in a sibling repo: the entry kept the opening ```
// and the first lines, the remainder moved behind a conditional pointer, and
// nothing failed. An odd fence count is the machine-detectable signature.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md'];

function markdownFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'agents'));
  // The always-loaded agent guides are instruction surfaces under the same
  // rule. `ALWAYS_LOADED` is asserted to be in the scan set by its own test, so
  // dropping it here fails loudly instead of silently shrinking coverage.
  for (const doc of ALWAYS_LOADED) {
    const p = path.join(ROOT, doc);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// Every `.md` under skills/ and agents/ — the documents an attacker would want
// to shadow. A bare `Read(`memory-distiller.md`)` names one of these with no
// basis at all, so it resolves against cwd (the target workspace root).
function pluginDocBasenames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) names.add(entry.name);
    }
  };
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'agents'));
  return names;
}
const PLUGIN_DOCS = pluginDocBasenames();

// Workspace-shadow guard.
//
// A bare `node scripts/harvest.js` or `Read skills/x/SKILL.md` resolves against
// the *target workspace*, not the plugin. A repository under analysis can put a
// file at that path and have it read as instructions or run with the caller's
// Bash permissions.
//
// Parent-relative forms (`../lib/x.md`) are just as shadowable. A markdown link
// resolves against the source file, but a runtime `Read` call has no such basis
// — it resolves against cwd, which is the target root. So this guard must NOT
// reuse the reference-integrity resolution below: integrity asks "does this
// file exist?" and may resolve relative to the source; the shadow guard asks
// "does this instruction name a trustworthy basis?", and only an explicit
// plugin-root anchor does.
//
// The guard is the machine form of the AGENTS.md sentence, which has two
// clauses. Both must hold for every instruction form, or the guard is narrower
// than the invariant it claims to enforce:
//
//   A. anchoring   — the path names the plugin root explicitly.
//   B. containment — the resolved path stays inside the plugin root.
//
// Clause B is not implied by A: `${CLAUDE_PLUGIN_ROOT}/../workspace/evil.js`
// carries the anchor and still escapes.
//
// Scope note: the invariant covers paths the plugin tells you to *open or run*.
// For `.js`/`.cjs`/`.mjs`/`.sh` that is every mention — naming an executable is
// only useful for running or loading it — so those are checked wherever they
// appear. For `.md` it is the instruction forms below.
// SEPARATORS. Windows is a supported host for this plugin (Node 22 on native
// Windows, per AGENTS.md), so `scripts\\harvest.js` names the same file as
// `scripts/harvest.js`. A matcher that knows only `/` lets the whole
// deny-by-default invariant be bypassed with one character: review found the
// slash form producing failures while the backslash form produced none.
//
// Every matcher below accepts either separator, and every extracted token is
// normalised **once**, in `scopedTokens`, so the classifier and the
// malicious-workspace fixture judge the same string and cannot disagree. Runs of
// separators collapse, so an escaped `scripts\\\\x.js` inside a string literal
// normalises to the same path. Over-normalising is the safe direction: a token
// only matters once it resolves to a real file in the plugin, and prose carrying
// a stray backslash resolves to nothing.
const SEP = String.raw`[\\/]`;
const normalizePath = (token) => token.replace(/[\\/]+/g, '/');

const PLUGIN_DIRS = 'skills|agents|scripts|hooks|dist|schemas';
// Two hosts, two env vars, one root. `scripts/lib/resource-root-resolver.js`
// resolves `env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT`, so both name the plugin
// root and both are real anchors; Codex sets the first, Claude Code the second.
const ANCHOR = String.raw`\$\{CLAUDE_PLUGIN_ROOT\}|\$\{PLUGIN_ROOT\}|<PLUGIN_ROOT>`;
const ANCHORED_TOKEN = new RegExp(`^(?:${ANCHOR})/`);
const PATH_BODY = String.raw`[A-Za-z0-9._/\\${'{}'}|$-]+`;
const REL = String.raw`\.{1,2}${SEP}`;
const ANY_ROOT = String.raw`(?:(?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})`;

// Each pattern captures the path token in group 1, so anchoring and containment
// are judged per token rather than per line — a line mixing an anchored and a
// bare path must still fail on the bare one.
const FORMS = [
  // 1. interpreter exec: `bash X`, `node X`, `sh X`, `python X`
  ['interpreter-exec', new RegExp(String.raw`\b(?:bash|sh|zsh|node|python3?)\s+["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 2. read verb: `Read X`, `Follow X`, `Read("X")`
  ['read-verb', new RegExp(String.raw`\b(?:Read|Follow|read|follow)\s*\(?\s*["'\`]?(${ANY_ROOT}${PATH_BODY}\.md)`, 'g')],
  // 3. direct exec / source: `source X`, `. X`, `exec X`, `./X`
  ['direct-exec', new RegExp(String.raw`(?:\b(?:source|exec)\s+|^\s*\.\s+)["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'gm')],
  // 4. module load: `require("X")`, `import … from "X"`
  ['module-load', new RegExp(String.raw`(?:\brequire\s*\(|\bfrom\s+)["'\`](${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 5. executable path token anywhere. The trailing boundary matters: without
  // it `.js` matches the prefix of `hooks/hooks.json` and the guard reports a
  // file that does not exist. `.cjs`/`.mjs` are in the set because this plugin
  // ships its hook and MCP entrypoints as those.
  //
  // The leading lookbehind exists to stop the matcher restarting mid-path; `/`
  // has always been in that class for exactly that reason, and `\\` is there to
  // make the protection separator-symmetric. No case in the suite proves the
  // backslash half — on every line tried, the anchored alternative matches first
  // and consumes through the extension, so the engine never attempts a restart.
  // It is kept as symmetry with an already-intentional guard rather than removed
  // for lack of an exploit, and recorded as an unproven axis.
  ['executable-token', new RegExp(String.raw`(?<![A-Za-z0-9._/\\{}<>$-])((?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})([A-Za-z0-9._/\\-]*\.(?:js|cjs|mjs|sh)(?![A-Za-z0-9]))`, 'g')],
];

// DENY BY DEFAULT.
//
// In the source repo, rounds 4-8 each added a syntax or extension to an
// allowlist and each time the next round found a form outside it. Enumerating
// what to recognise is the losing half of the problem.
//
// So the question is not "is this a known instruction syntax?" but "does this
// token resolve to a real file in the plugin?". Anything that does must be
// anchored, whatever the verb, extension or sentence around it — which covers
// .json, .yaml, extensionless scripts and assets that do not exist yet, without
// another form list. Anything that does not resolve is prose and passes.
const PLUGIN_FILES = (() => {
  const rel = new Set();
  // docs/ and tests/ are not runtime-loaded plugin assets (same rationale as the
  // reference guard). The `.deep-*` entries are workspace outputs this plugin
  // writes into a project, never things it loads.
  const skip = new Set(['node_modules', '.git', '.claude', 'docs',
    'tests', '.deep-review', '.deep-memory', '.deep-docs', '.deep-suite-cache']);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else rel.add(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  return rel;
})();

// The only permitted exceptions, each with the reason it is safe.
const ALLOWLIST = new Map();

// Paths this plugin never ships. `docs/` is gitignored here, so `docs/DOCS_RULE.md`
// cannot resolve inside an installed plugin at all — the only place it *can*
// resolve is the project being analysed, which makes it the same hazard class as
// an unanchored plugin path, arrived at from the opposite direction.
// Deny-by-default cannot see it: that rule only flags what resolves inside the
// plugin. So the exemption is carried by the sentence telling a reader not to
// open it, and that sentence is asserted rather than assumed.
const NON_SHIPPED = new Map([
  ['docs/DOCS_RULE.md', [
    /ships with nothing/,
    /never try to open it at runtime/,
    /only place that path can resolve in an installed plugin is the project being analysed/,
  ]],
]);

// Blockquote markers and hard wraps must not decide whether a caveat counts, so
// the required clauses are matched against a flattened body.
function flatten(body) {
  return body.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');
}

// The portable version-read command is pinned verbatim, as a literal string, by
// `scripts/validate-docs-rulebooks.cjs` (PLUGIN_VERSION_COMMANDS) and asserted
// against both guides by `tests/release-contract.test.js`. It is a maintainer
// command for the plugin checkout — `node -e` resolves a relative `require`
// against the process cwd, which for this command is the plugin repo — not an
// instruction issued to an agent operating on a target workspace. Anchoring it
// means editing `scripts/`, which is outside this refactor's surface, so the
// deviation is exempted here by exact line shape and recorded in the PR.
const PINNED_VERSION_COMMAND =
  /^Current version: `node -e "console\.log\(require\('\.\/\.(?:claude|codex)-plugin\/plugin\.json'\)\.version\)"`$/;

// Single-segment root metadata named descriptively ("package.json declares
// engines"), never handed to a file tool. Multi-segment paths get no such pass.
const ROOT_METADATA = new Set(['package.json', 'plugin.json', 'config.yaml',
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', 'SKILL.md', 'hooks.json']);

// Path-shaped tokens: multi-segment paths, plus dotted single segments.
// The inter-segment class takes a RUN of separators, not one. `normalizePath`
// already collapses runs, but that happens *after* tokenization — and a
// tokenizer that accepts only a single separator never produces the token to
// normalise. On `scripts\\\\harvest.js` the multi-segment alternative fails at the
// second backslash, the regex falls through to the bare-basename alternative,
// and yields `harvest.js`, which is not a repo-relative path and so matches
// nothing in PLUGIN_FILES.
//
// The consequence was silent and specific: FORMS still flagged the line, because
// PATH_BODY consumes backslashes, so the classifier objected. But the
// malicious-workspace fixture — the only layer that proves an instruction
// actually lands on a planted file — plants from these tokens, so it saw
// nothing and passed. One layer complaining while the layer that proves
// reachability goes blind is the worst shape a guard can have, because the
// failure count still looks right.
const PATH_TOKEN = /[A-Za-z0-9_.@${}<>-]+(?:[\\/]+[A-Za-z0-9_.@{}|*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g;

function resolvesInPlugin(token, sourceFile) {
  const clean = normalizePath(token).replace(/^\.\//, '');
  if (PLUGIN_FILES.has(clean)) return true;
  try {
    const fromSource = path.relative(ROOT, path.resolve(path.dirname(sourceFile), normalizePath(token)));
    if (PLUGIN_FILES.has(fromSource)) return true;
  } catch { /* unresolvable token — prose */ }
  return false;
}

// Scope, defined once. Yields the path tokens on a line that the invariant
// governs, with the documented exemptions applied. Both the classifier and the
// malicious-workspace fixture consume this, so they cannot test different rules.
function* scopedTokens(line) {
  if (PINNED_VERSION_COMMAND.test(line.trim())) return;
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(line))) {
    // `<` and `>` are in the character class only to admit `<PLUGIN_ROOT>`.
    // Without trimming them, `<skills/…/llm-output.json 첨부>` extracts with a
    // leading `<`, fails to resolve, and the token silently escapes the guard.
    let token = m[0].startsWith('<') && !m[0].startsWith('<PLUGIN_ROOT>')
      ? m[0].slice(1)
      : m[0];
    // Normalise once, here, so every consumer of scopedTokens — the classifier
    // and the malicious-workspace fixture alike — judges the same string.
    token = normalizePath(token);
    if (ALLOWLIST.has(token)) continue;
    // Forward defence only: a non-shipped path never resolves in the plugin, so
    // deny-by-default would pass it anyway. Kept so that adding such a path to
    // the shipped set turns the NON_SHIPPED test red instead of silently
    // changing this rule's behaviour.
    if (NON_SHIPPED.has(token)) continue;
    if (!token.includes('/') && ROOT_METADATA.has(token)) continue;
    const before = line.slice(Math.max(0, m.index - 30), m.index);
    // Already inside an anchored path. The trailing form covers shell splicing
    // — require("'"${CLAUDE_PLUGIN_ROOT}"'/scripts/x.js") is anchored, just
    // quoted for a heredoc.
    if (/(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$\{PLUGIN_ROOT\}|<PLUGIN_ROOT>)["'\s]*[\\/]?$/.test(before)) continue;
    // Markdown link target `](x.md)` — rendered navigation between docs, not an
    // instruction handed to a file tool. Runtime reads use the Read forms above.
    if (/\]\($/.test(before)) continue;
    yield token;
  }
}

// `pluginRequire("scripts/lib/x.js")` is anchored *programmatically*: the helper
// resolves against a realpath'd plugin-root env var and throws if the result
// leaves the root, which is stronger than a text anchor because it cannot be
// defeated by a quoting context. It is only accepted where the file actually
// defines that helper with its containment check — otherwise the name would
// become a magic word that turns the guard off.
const PLUGIN_REQUIRE_CALL = /\bpluginRequire\s*\(\s*["'`]([^"'`]+)["'`]/g;
function definesPluginRequire(body) {
  return /const\s+pluginRequire\s*=/.test(body)
    && /realpathSync\s*\(\s*process\.env\.(?:CLAUDE_)?PLUGIN_ROOT/.test(body)
    && /escapes root/.test(body);
}

function denyByDefaultHits(line, sourceFile, body) {
  const programmatic = new Set();
  if (body && definesPluginRequire(body)) {
    PLUGIN_REQUIRE_CALL.lastIndex = 0;
    let pm;
    while ((pm = PLUGIN_REQUIRE_CALL.exec(line))) programmatic.add(pm[1]);
  }
  const out = [];
  for (const token of scopedTokens(line)) {
    // Anchored tokens fall through to the clause-B checks in the branches
    // below (escapesRoot / escapesViaSymlink) — they are not exempt. The
    // old comment here read as though this line *deferred* the check to
    // somewhere else; a review probe planting a real traversal target
    // confirmed every form is still rejected with 'escapes plugin root'.
    // Comment corrected, logic deliberately unchanged.
    if (ANCHORED_TOKEN.test(token)) continue;
    if (programmatic.has(token)) continue;             // anchored by the helper
    if (resolvesInPlugin(token, sourceFile)) {
      out.push({ form: 'resolves-in-plugin', token, why: 'unanchored' });
    }
  }
  return out;
}

// bare basename read: `Read(`memory-distiller.md`)`. It resolves to no
// repo-relative path, so the rule above cannot see it — yet it is the weakest
// form of all, resolving straight against cwd. Only basenames that name a real
// plugin document are flagged, so ordinary prose is untouched.
//
// KNOWN GAP (shared with the reference guard): this form covers `.md` only, and
// `PATH_TOKEN` does not reliably extract a dotted single-segment basename, so a
// bare `Read(`x.schema.json`)` would slip through both. Exposure today is zero —
// the two `.json` basenames in the corpus (harvest §Steps, audit §Sub-commands)
// are descriptive prose, not load instructions. Widen the extension class here
// before turning either into an instruction.
const BARE_BASENAME = /\b(?:Read|Follow|read|follow)\s*\(?\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#[^`"']*)?["'`]/g;

function bareBasenameHits(line) {
  const out = [];
  BARE_BASENAME.lastIndex = 0;
  let m;
  while ((m = BARE_BASENAME.exec(line))) {
    if (PLUGIN_DOCS.has(m[1])) {
      out.push({ form: 'bare-basename', token: m[1], why: 'unanchored' });
    }
  }
  return out;
}

// EXPANSION SAFETY.
//
// An anchor is only an anchor if the shell actually expands it. Inside a
// single-quoted string `${CLAUDE_PLUGIN_ROOT}` survives as a literal, and the
// consumer then reads a path *named* `${CLAUDE_PLUGIN_ROOT}/...` relative to the
// workspace — so anchoring a path into a single-quoted JSON payload converts a
// fixed reference into a shadowable one.
//
// Quote state must be tracked as a small machine, not by counting quotes: in
// `node -e "…require('fs')…"` the single quotes are JS-level, sit inside a
// double-quoted shell word, and expansion still happens. A naive counter calls
// that broken.
function expansionState(line, index) {
  let state = 'normal';
  for (let k = 0; k < index; k += 1) {
    const c = line[k];
    if (line[k - 1] === '\\') continue;
    if (state === 'normal') {
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
    } else if (state === 'single') {
      if (c === "'") state = 'normal';
    } else if (c === '"') state = 'normal';
  }
  return state;
}

// Only a line that is actually a command can suffer this; prose containing an
// apostrophe is not a shell word.
const SHELL_COMMAND = /\b(?:echo|printf|cat|node|bash|sh|zsh|jq|awk|sed|curl|export)\b/;

// `${...}` only interpolates in a JS *template literal*. In a quoted string it
// is inert, and a specifier that does not start with ./ ../ or / is a bare
// package specifier — so `require("${CLAUDE_PLUGIN_ROOT}/scripts/x.js")` sends
// Node looking in `node_modules/${CLAUDE_PLUGIN_ROOT}/scripts/x.js` inside the
// *workspace*. Planting that module is arbitrary code execution, which makes
// this the most severe form of the expansion axis rather than a broken path.
// Backticks included deliberately: a template literal interpolates a *local
// variable* of that name, not the environment — an undefined one is a
// ReferenceError, and a defined one is attacker-influenced.
// `from` alone is not enough once backticks are in play: markdown inline code
// makes "cards come from `${CLAUDE_PLUGIN_ROOT}/schemas/…`" look like an import.
// So `from` must be preceded by `import` on the same line.
const JS_SPECIFIER = /(?:\brequire\s*\(|\bimport\s*\(|\bimport\b[^;\n]*?\bfrom\s+)\s*(["'`])((?:(?!\1).)*\$\{[^}]+\}(?:(?!\1).)*)\1/g;

// JSON and YAML have no interpolation at all: a `${...}` in a value is data.
const JSON_YAML_VALUE = /"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*"[^"]*\$\{(?:CLAUDE_)?PLUGIN_ROOT\}[^"]*"|^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*["']?[^"'\n]*\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/;

// The expansion axis, generalised by language. Each context answers one
// question: given where this anchor sits, does anything expand it?
function nonExpandingAnchors(line) {
  const out = [];
  const flag = (token, why) => out.push({ form: 'non-expanding-anchor', token, why });

  // 1. shell — single quotes and quoted heredocs leave it literal
  for (const name of ['${CLAUDE_PLUGIN_ROOT}', '${PLUGIN_ROOT}']) {
    let i = line.indexOf(name);
    while (i !== -1) {
      if (SHELL_COMMAND.test(line) && expansionState(line, i) === 'single') {
        flag(name, 'single-quoted shell — literal, so the path resolves against the workspace');
      }
      i = line.indexOf(name, i + 1);
    }
  }

  // 2. JS/TS quoted string used as a module specifier — bare specifier → node_modules
  JS_SPECIFIER.lastIndex = 0;
  let m;
  while ((m = JS_SPECIFIER.exec(line))) {
    // Report the anchor the line actually used. Hardcoding one name makes the
    // diagnostic point at a variable the file never mentions.
    const named = /\$\{CLAUDE_PLUGIN_ROOT\}/.test(m[2]) ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}';
    if (m[1] === "`") {
      flag(named, "JS template literal — interpolates a local variable of that name, not the "
        + "environment; undefined is a ReferenceError and a defined one is attacker-influenced");
    } else {
      flag(named, `JS ${m[1] === '"' ? 'double' : 'single'}-quoted specifier — not interpolated, `
        + 'so Node resolves it as a bare package name under the workspace node_modules');
    }
  }

  // 3. JSON / YAML value — no interpolation in either format. An
  // angle-bracketed value is the suite convention for "described, not literal"
  // (`"<from ${CLAUDE_PLUGIN_ROOT}/…>"` documents where a field comes from), so
  // it is a schema annotation rather than a path anyone resolves.
  const angleDescribed = /<[^<>]*\$\{(?:CLAUDE_)?PLUGIN_ROOT\}[^<>]*>/.test(line);
  if (JSON_YAML_VALUE.test(line) && !SHELL_COMMAND.test(line) && !angleDescribed) {
    flag('${CLAUDE_PLUGIN_ROOT}', 'JSON/YAML value — neither format interpolates, so the anchor is stored literally');
  }

  return out;
}

const ROOT_SENTINEL = path.sep === '/' ? '/plugin-root' : 'C:\\plugin-root';

// Clause B. Substitute the anchor with a sentinel root, resolve, and require
// the result to stay inside it. Tokens carrying template placeholders
// (`<memory_type>`, `$WORK_DIR`) cannot be resolved literally, so they are
// checked lexically for `..` instead.
function escapesRoot(token) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return body.split('/').includes('..');
  const resolved = path.resolve(ROOT_SENTINEL, body);
  return resolved !== ROOT_SENTINEL && !resolved.startsWith(ROOT_SENTINEL + path.sep);
}

// Symlink escape: an anchored, lexically-contained path can still point out of
// the root if a component is a symlink. Only checkable for targets that exist.
function escapesViaSymlink(token) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (/[{}|$]/.test(body)) return false;
  const target = path.join(ROOT, body);
  if (!fs.existsSync(target)) return false;
  const real = fs.realpathSync(target);
  const realRoot = fs.realpathSync(ROOT);
  return real !== realRoot && !real.startsWith(realRoot + path.sep);
}

// Indented too: fences nested in a list item or a numbered step are still fences.
// A column-0-only match leaves fenced blocks inside list items unchecked.
const FENCE = /^[ \t]*```/gm;

test('every skill and agent markdown file has balanced code fences', () => {
  const unbalanced = [];
  for (const file of markdownFiles()) {
    const fences = (fs.readFileSync(file, 'utf8').match(FENCE) || []).length;
    if (fences % 2 !== 0) unbalanced.push(`${path.relative(ROOT, file)} (${fences})`);
  }
  assert.deepEqual(unbalanced, [],
    `unclosed code fence — a split or edit truncated a fenced block:\n  ${unbalanced.join('\n  ')}`);
});

// Returns violations on a line: {form, token, why}. Empty when the line is clean.
function shadowableTokens(line, sourceFile = path.join(ROOT, 'AGENTS.md'), body = '') {
  // Exempt by exact line shape, not by token: the `require('./…plugin.json')`
  // inside it would otherwise be caught by the module-load form as well.
  if (PINNED_VERSION_COMMAND.test(line.trim())) return [];
  const out = [];
  const programmaticAll = new Set();
  if (body && definesPluginRequire(body)) {
    PLUGIN_REQUIRE_CALL.lastIndex = 0;
    let pm;
    while ((pm = PLUGIN_REQUIRE_CALL.exec(line))) programmaticAll.add(pm[1]);
  }
  for (const [form, re] of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const token = normalizePath(m[2] === undefined ? m[1] : m[1] + m[2]);
      if (programmaticAll.has(token)) continue;
      if (!ANCHORED_TOKEN.test(token)) out.push({ form, token, why: 'unanchored' });
      else if (escapesRoot(token)) out.push({ form, token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token)) out.push({ form, token, why: 'escapes via symlink' });
    }
  }
  out.push(...bareBasenameHits(line));
  out.push(...denyByDefaultHits(line, sourceFile, body));
  out.push(...nonExpandingAnchors(line));
  return out;
}

test('the always-loaded agent guides are in the scan set', () => {
  // Asserting membership means the coverage claim is checked by the suite
  // rather than by a commit message.
  const scanned = markdownFiles().map((f) => path.relative(ROOT, f));
  for (const doc of ALWAYS_LOADED) {
    assert.ok(fs.existsSync(path.join(ROOT, doc)), `${doc} must exist to be scanned`);
    assert.ok(scanned.includes(doc), `${doc} must be in the shadow-guard scan set`);
  }
});

test('every user skill and the distiller agent are in the scan set', () => {
  // The scan set must not silently shrink when a skill is added or renamed.
  const scanned = markdownFiles().map((f) => path.relative(ROOT, f));
  const skills = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => `skills/${e.name}/SKILL.md`);
  assert.ok(skills.length >= 7, `expected the shipped skill set, saw ${skills.length}`);
  for (const rel of [...skills, 'agents/memory-distiller.md']) {
    assert.ok(scanned.includes(rel), `${rel} must be in the shadow-guard scan set`);
  }
});

test('no read or exec instruction can be shadowed from the target workspace', () => {
  const violations = [];
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    body.split('\n').forEach((line, i) => {
      for (const v of shadowableTokens(line, file, body)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  [${v.form}] ${v.token} — ${v.why}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'plugin path read/executed outside the plugin root — anchor at '
    + `\${CLAUDE_PLUGIN_ROOT} (\${PLUGIN_ROOT} on Codex) and keep it inside the `
    + `root:\n  ${violations.join('\n  ')}`);
});

// One positive and one negative per instruction form, so the coverage claim is
// itself tested. A form with no case here is a form the guard does not enforce.
const FORM_CASES = [
  ['interpreter-exec', 'node scripts/harvest.js <artifact-path> --kind work-receipt',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/harvest.js" <artifact-path> --kind work-receipt'],
  ['read-verb', 'Read `agents/memory-distiller.md` and follow it',
    'Read `${CLAUDE_PLUGIN_ROOT}/agents/memory-distiller.md` and follow it'],
  ['direct-exec', 'source scripts/hooks/common.mjs',
    'source ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/common.mjs'],
  // The "safe" side is NOT require("${CLAUDE_PLUGIN_ROOT}/…") — that is the
  // node_modules hijack below, since JS does not interpolate a quoted string.
  ['module-load', 'const x = require("scripts/lib/llm-bridge.js");',
    'const x = pluginRequire("scripts/lib/llm-bridge.js");'],
  ['executable-token', 'the MCP bundle is `dist/mcp-server.cjs`',
    'the MCP bundle is `${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.cjs`'],
  ['bare-basename', 'Read(`memory-distiller.md`)',
    'Read(`${CLAUDE_PLUGIN_ROOT}/agents/memory-distiller.md`)'],
  ['dot-relative', 'Read(`../deep-memory-audit/SKILL.md`)',
    'Read(`${CLAUDE_PLUGIN_ROOT}/skills/deep-memory-audit/SKILL.md`)'],
  // Codex names the same root through a different variable; both must pass.
  ['codex-anchor', 'Read `agents/memory-distiller.md`',
    'Read `${PLUGIN_ROOT}/agents/memory-distiller.md`'],
];

// A body that defines the helper with its containment check. pluginRequire is
// only trusted where this definition is present — the name alone must not
// disable the guard, so the negative side is asserted without it.
const HELPER_BODY = [
  'const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");',
  'const pluginRequire = (rel) => { throw new Error("plugin path escapes root: " + rel); };',
].join(String.fromCharCode(10));

test('every enumerated instruction form is enforced (positive + negative)', () => {
  for (const [form, bad, good] of FORM_CASES) {
    assert.ok(shadowableTokens(bad, undefined, HELPER_BODY).length > 0,
      `${form}: guard must flag — ${bad}`);
    assert.deepEqual(shadowableTokens(good, undefined, HELPER_BODY), [],
      `${form}: guard must accept — ${good}`);
  }
});

test('pluginRequire is not a magic word — it only counts where the helper is defined', () => {
  const call = 'const x = pluginRequire("scripts/lib/llm-bridge.js");';
  assert.deepEqual(shadowableTokens(call, undefined, HELPER_BODY), [],
    'accepted when the containment helper is defined in the same document');
  assert.ok(shadowableTokens(call, undefined, '// no helper here').length > 0,
    'rejected when the document never defines the helper');
});

test('anchored paths that escape the plugin root are rejected (containment)', () => {
  // Clause B. Each carries a valid anchor prefix and still leaves the root, so
  // a prefix-only check passes all four.
  const traversals = [
    'Read `${CLAUDE_PLUGIN_ROOT}/../workspace/evil.md`',
    'node "${CLAUDE_PLUGIN_ROOT}/../workspace/evil.js"',
    'node "${PLUGIN_ROOT}/../workspace/evil.js"',
    'bash <PLUGIN_ROOT>/../../tmp/evil.sh',
  ];
  for (const line of traversals) {
    const hits = shadowableTokens(line);
    assert.ok(hits.length > 0, `containment must reject: ${line}`);
    assert.equal(hits[0].why, 'escapes plugin root', `wrong reason for: ${line}`);
  }
  // A `..` that stays inside the root is fine.
  assert.deepEqual(
    shadowableTokens('Read `${CLAUDE_PLUGIN_ROOT}/skills/a/../deep-memory-init/SKILL.md`'), [],
    'in-root traversal must be accepted');
});

test('a malicious workspace cannot shadow any instruction the plugin issues', () => {
  // End-to-end statement of the invariant, and the fixture that decides whether
  // a finding is real. Plant a shadow at *every* plugin path these documents
  // name — including the ones no syntax list would recognise, such as the
  // distiller response schema — then confirm no instruction resolves onto one.
  // Because every instruction is anchored, cwd is irrelevant, which is the
  // property under test rather than an accident of which files were planted.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-evil-workspace-'));
  try {
    const planted = new Set();
    const plant = (rel) => {
      const target = path.join(evil, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rel.endsWith('.md') ? '# SHADOW — must never be read\n'
        : rel.endsWith('.json') ? '{"SHADOW":"must never be consumed"}\n'
          : 'process.stdout.write("SHADOW");\n');
      planted.add(rel);
    };
    for (const file of markdownFiles()) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        for (const token of scopedTokens(line)) {
          // Strip the anchor before planting. An anchored token is precisely
          // the case worth testing: the workspace holds a file at the same
          // relative path, and the anchor is the only thing keeping the agent
          // off it. Planting only unanchored tokens would make this fixture
          // empty the moment the documents are fixed.
          const clean = token.replace(new RegExp(`^(?:${ANCHOR})/`), '').replace(/^\.\//, '');
          if (PLUGIN_FILES.has(clean)) plant(clean);
        }
      }
    }
    // A bare basename resolves against cwd with no directory at all.
    for (const name of ['memory-distiller.md', 'SKILL.md']) plant(name);
    // Non-vacuity control, planted unconditionally so the check below cannot
    // pass merely because the sweep found nothing.
    plant('agents/memory-distiller.md');

    // Resolve for real, from the evil cwd, exactly as a runtime agent would.
    const resolveAsAgentWould = (token) => {
      if (/^(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$\{PLUGIN_ROOT\}|<PLUGIN_ROOT>)\//.test(token)) {
        const body = token.replace(/^(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$\{PLUGIN_ROOT\}|<PLUGIN_ROOT>)\//, '');
        return path.resolve(ROOT, body);      // anchored → resolves in the plugin
      }
      return path.resolve(evil, token.replace(/^\.\//, '')); // unanchored → cwd
    };

    const landed = [];
    for (const file of markdownFiles()) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const token of scopedTokens(line)) {
          const target = resolveAsAgentWould(token);
          if (target.startsWith(evil + path.sep) && fs.existsSync(target)) {
            landed.push(`${path.relative(ROOT, file)}:${i + 1}  ${token} → ${target}`);
          }
        }
      });
    }
    assert.deepEqual(landed, [],
      `these instructions resolve onto a planted shadow file:\n  ${landed.join('\n  ')}`);

    // Non-vacuity: the same resolution, given an unanchored token, does land on
    // the shadow — so an empty result above is a property of the docs, not of a
    // resolver that never finds anything.
    const control = resolveAsAgentWould('agents/memory-distiller.md');
    assert.ok(control.startsWith(evil + path.sep) && fs.existsSync(control),
      'fixture is vacuous — an unanchored token must land on the planted shadow');
    assert.ok(planted.size >= 10,
      `fixture planted only ${planted.size} shadows — the token sweep has rotted`);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('an anchor the shell will not expand counts as unanchored', () => {
  // [line, expected reason] — the reason is asserted per case, because the axis
  // spans languages and "single-quoted" is only the shell answer.
  const mustFlag = [
    [`echo '{"root":"\${CLAUDE_PLUGIN_ROOT}/schemas/memory-card.schema.json"}' | node x.js`, /single-quoted shell/],
    [`printf '%s' '\${PLUGIN_ROOT}/scripts/harvest.js'`, /single-quoted shell/],
    ['const { m } = require(\`\${CLAUDE_PLUGIN_ROOT}/scripts/lib/llm-bridge.js\`);', /template literal/],
    ['const x = require("\${CLAUDE_PLUGIN_ROOT}/scripts/lib/redact.js");', /bare package name/],
    ['import x from \'\${CLAUDE_PLUGIN_ROOT}/scripts/lib/lock.js\';', /bare package name/],
  ];
  for (const [line, reason] of mustFlag) {
    const hits = nonExpandingAnchors(line);
    assert.equal(hits.length, 1, `must flag non-expanding anchor: ${line}`);
    assert.match(hits[0].why, reason, `wrong reason for: ${line}`);
  }

  const mustPass = [
    // double-quoted shell word: the inner single quotes are JS-level, and the
    // shell still expands. A naive quote counter gets this one wrong.
    `node -e "JSON.parse(require('fs').readFileSync('\${CLAUDE_PLUGIN_ROOT}/.codex-plugin/plugin.json','utf8'))"`,
    // close-single / open-double splice inside a single-quoted heredoc body
    `  const { x } = require("'"\${CLAUDE_PLUGIN_ROOT}"'/scripts/lib/redact.js");`,
    // plain expanding position
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/harvest.js" --kind work-receipt`,
    // prose, not a command
    'Reads `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` for the version',
  ];
  for (const line of mustPass) {
    assert.deepEqual(nonExpandingAnchors(line), [], `must accept: ${line}`);
  }
});

test('the documented harvest command survives real shell semantics', () => {
  // Runs the shape the harvest skill documents, from a malicious cwd that has
  // planted a file at the literal path a non-expanding anchor would produce.
  // Proves three things at once: the canonical script is what gets executed,
  // the planted marker never runs, and an unresolvable root aborts.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-shell-evil-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-shell-plugin-'));
  try {
    // The literal path a single-quoted anchor leaves behind.
    fs.mkdirSync(path.join(evil, '${CLAUDE_PLUGIN_ROOT}', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, '${CLAUDE_PLUGIN_ROOT}', 'scripts', 'harvest.js'),
      'process.stdout.write("SHADOW-HARVEST");\n');
    fs.mkdirSync(path.join(evil, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'scripts', 'harvest.js'),
      'process.stdout.write("SHADOW-HARVEST");\n');
    fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'scripts', 'harvest.js'),
      'process.stdout.write("CANONICAL-HARVEST");\n');

    // The command shape the harvest skill documents, with the two guarantees a
    // caller must reproduce made explicit: the root is resolved with `pwd -P`
    // (so a symlinked component cannot smuggle the path elsewhere) and the
    // resolved target is required to stay under it. An earlier version of this
    // test ran a wrapper that checked neither, so it proved only that *some*
    // absolute path executes — not that the documented one is contained.
    const script = `
      PLUGIN_ROOT_RESOLVED="$(cd "\${CLAUDE_PLUGIN_ROOT:?unset}" 2>/dev/null && pwd -P)"
      [ -n "$PLUGIN_ROOT_RESOLVED" ] || { echo "ABORT" >&2; exit 1; }
      TARGET="$(cd "$(dirname "$PLUGIN_ROOT_RESOLVED/scripts/harvest.js")" 2>/dev/null && pwd -P)/harvest.js"
      case "$TARGET" in
        "$PLUGIN_ROOT_RESOLVED"/*) ;;
        *) echo "ABORT: target escapes plugin root" >&2; exit 1 ;;
      esac
      [ -f "$TARGET" ] || { echo "ABORT" >&2; exit 1; }
      node "$TARGET"
    `;
    const run = (env, cwd) => require('node:child_process')
      .spawnSync('bash', ['-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

    const ok = run({ CLAUDE_PLUGIN_ROOT: fakeRoot }, evil);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'CANONICAL-HARVEST',
      'must execute the canonical plugin script, never the planted one');
    assert.doesNotMatch(ok.stdout, /SHADOW|\$\{CLAUDE_PLUGIN_ROOT\}/,
      'planted marker and literal anchor must never reach the output');

    // Non-vacuity: the planted shadow is genuinely reachable if the anchor
    // stays literal, which is exactly what an unanchored form does.
    const bare = require('node:child_process')
      .spawnSync('bash', ['-c', 'node scripts/harvest.js'], { cwd: evil, encoding: 'utf8' });
    assert.equal(bare.stdout.trim(), 'SHADOW-HARVEST',
      'fixture is vacuous — the unanchored form must reach the planted shadow');

    // Fail-closed when the root does not resolve.
    const badRun = run({ CLAUDE_PLUGIN_ROOT: path.join(evil, 'does-not-exist') }, evil);
    assert.notEqual(badRun.status, 0, 'unresolvable plugin root must abort');
    assert.match(badRun.stderr, /ABORT/);

    // Containment, executed. A root whose `scripts/` is a symlink pointing out
    // of the root passes every lexical check and still leaves the plugin, so
    // `pwd -P` on the target's directory is the only thing that catches it.
    // Without this case the case-esac guard above is unproven: mutating it to
    // accept everything leaves the whole test green.
    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-shell-linked-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-shell-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'harvest.js'),
        'process.stdout.write("OUTSIDE-HARVEST");\n');
      fs.symlinkSync(outside, path.join(linkedRoot, 'scripts'));
      const escaped = run({ CLAUDE_PLUGIN_ROOT: linkedRoot }, evil);
      assert.notEqual(escaped.status, 0, 'a symlinked scripts/ that leaves the root must abort');
      assert.match(escaped.stderr, /escapes plugin root/);
      assert.doesNotMatch(escaped.stdout, /OUTSIDE-HARVEST/,
        'the out-of-root script must never execute');
    } finally {
      fs.rmSync(linkedRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test('the plugin obeys the rules it states', () => {
  // Self-consistency axis: a rule these documents state, violated inside the
  // documents that state it. Writing a rule is not enforcing it.
  const violations = [];
  const distiller = fs.readFileSync(path.join(ROOT, 'agents', 'memory-distiller.md'), 'utf8');
  const distillerTools = (distiller.match(/^tools:\s*(.+)$/m) || [])[1] || '';

  // The harvest skill promises the Codex mediator preserves the distiller's
  // read-only restriction. That promise is only true if the agent definition
  // actually grants read-only tools — the distiller is fed artifact text that
  // the workspace controls, so a write tool there is a prompt-injection sink.
  const granted = distillerTools.split(',').map((t) => t.trim()).filter(Boolean);
  assert.deepEqual(granted, ['Read', 'Glob', 'Grep'],
    'memory-distiller must stay read-only — the skills state it as a contract');

  for (const file of markdownFiles()) {
    const rel = path.relative(ROOT, file);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const at = `${rel}:${i + 1}`;

      // A path derived from the reading document's own location resolves
      // against the workspace once the document is read from there.
      if (/directory containing this|이 파일이 있는 (디렉터리|디렉토리)/.test(line)
          && !/말 것|하지 마|never|must not/i.test(line)) {
        violations.push(`${at}  source-relative derivation`);
      }

      // The guides and the docs rulebook require Node for version and manifest
      // reads; jq is absent on the supported Windows host.
      if (/\bjq\b/.test(line)) violations.push(`${at}  jq in an instruction surface`);
    });
  }
  assert.deepEqual(violations, [],
    `the plugin violates a rule it states:\n  ${violations.join('\n  ')}`);
});

test('a planted node_modules shadow cannot hijack a plugin require', () => {
  // `require("${VAR}/x.js")` is a *bare* specifier — not absolute — so Node
  // walks node_modules from cwd. Executed rather than argued.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-nm-evil-'));
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-nm-plugin-'));
  const { spawnSync } = require('node:child_process');
  try {
    const shadowDir = path.join(evil, 'node_modules', '${CLAUDE_PLUGIN_ROOT}', 'scripts', 'lib');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'redact.js'),
      'module.exports = { marker: "ATTACKER" };\n');
    fs.mkdirSync(path.join(realRoot, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(realRoot, 'scripts', 'lib', 'redact.js'),
      'module.exports = { marker: "CANONICAL" };\n');

    const run = (src) => spawnSync(process.execPath, ['-e', src],
      { cwd: evil, env: { ...process.env, CLAUDE_PLUGIN_ROOT: realRoot }, encoding: 'utf8' });

    // Non-vacuity: the planted module really is reachable via the broken form.
    const vulnerable = run('console.log(require("${CLAUDE_PLUGIN_ROOT}/scripts/lib/redact.js").marker)');
    assert.equal(vulnerable.status, 0, vulnerable.stderr);
    assert.equal(vulnerable.stdout.trim(), 'ATTACKER',
      'fixture is vacuous — the planted shadow must be reachable via the unsafe form');

    // The documented pattern resolves from env, with containment.
    const safe = run(`
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const t = nodePath.resolve(PLUGIN_ROOT, rel);
        if (t !== PLUGIN_ROOT && !t.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(t);
      };
      console.log(pluginRequire("scripts/lib/redact.js").marker);
    `);
    assert.equal(safe.status, 0, safe.stderr);
    assert.equal(safe.stdout.trim(), 'CANONICAL',
      'the documented pattern must load the plugin module, never the planted one');

    // Containment: a traversing relative path is refused, not resolved.
    const escaping = run(`
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const t = nodePath.resolve(PLUGIN_ROOT, rel);
        if (t !== PLUGIN_ROOT && !t.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(t);
      };
      pluginRequire("../evil.js");
    `);
    assert.notEqual(escaping.status, 0, 'an escaping path must throw');
    assert.match(escaping.stderr, /escapes root/);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

test('markdown link destinations are never environment variables', () => {
  // The mirror image of the anchor rule. Markdown does not interpolate, so an
  // anchored link destination is a literal broken URL. Link targets are the
  // documented exception class in the guard; this asserts the exception is
  // actually honoured in the documents.
  const broken = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const re = /\]\((\$\{[^)]*|<PLUGIN_ROOT>[^)]*)\)/g;
      let m;
      while ((m = re.exec(line))) {
        broken.push(`${path.relative(ROOT, file)}:${i + 1}  ](${m[1]})`);
      }
    });
  }
  assert.deepEqual(broken, [],
    'markdown link destination uses a variable that nothing expands — use a '
    + `source-relative path instead:\n  ${broken.join('\n  ')}`);
});

test('pluginRequire refuses a symlink that leaves the plugin root', () => {
  // path.resolve is lexical, so a symlink inside the root pointing outside
  // passes a prefix check and require then follows it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-symlink-plugin-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-symlink-outside-'));
  const { spawnSync } = require('node:child_process');
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'evil.js'), 'module.exports={marker:"OUTSIDE"};\n');
    fs.writeFileSync(path.join(root, 'scripts', 'ok.js'), 'module.exports={marker:"INSIDE"};\n');
    fs.symlinkSync(path.join(outside, 'evil.js'), path.join(root, 'scripts', 'evil.js'));

    const helper = `
      const nodePath = require("node:path"), nodeFs = require("node:fs");
      const PLUGIN_ROOT = nodeFs.realpathSync(process.env.CLAUDE_PLUGIN_ROOT || "");
      const pluginRequire = (rel) => {
        const target = nodeFs.realpathSync(nodePath.resolve(PLUGIN_ROOT, rel));
        if (target !== PLUGIN_ROOT && !target.startsWith(PLUGIN_ROOT + nodePath.sep)) {
          throw new Error("plugin path escapes root: " + rel);
        }
        return require(target);
      };`;
    const run = (src) => spawnSync(process.execPath, ['-e', helper + src],
      { env: { ...process.env, CLAUDE_PLUGIN_ROOT: root }, encoding: 'utf8' });

    const escaped = run('console.log(pluginRequire("scripts/evil.js").marker);');
    assert.notEqual(escaped.status, 0, 'a symlink out of the root must be refused');
    assert.match(escaped.stderr, /escapes root/);

    const inside = run('console.log(pluginRequire("scripts/ok.js").marker);');
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(inside.stdout.trim(), 'INSIDE', 'an in-root module must still load');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the documented pluginRequire helpers realpath their target', () => {
  // The runtime behaviour above is only protective if the documents state it.
  const missing = [];
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    if (!/const\s+pluginRequire\s*=/.test(body)) continue;
    if (!/realpathSync\s*\(\s*nodePath\.resolve\s*\(\s*PLUGIN_ROOT/.test(body)) {
      missing.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(missing, [],
    'pluginRequire resolves lexically without realpath — a symlink out of the '
    + `root would be followed:\n  ${missing.join('\n  ')}`);
});

test('a backslash separator does not hide a path from the guard', () => {
  // Review found the slash form producing failures while the backslash form
  // produced none — one character defeating deny-by-default on a plugin whose
  // supported hosts include native Windows.
  //
  // Each case is asserted on the FORM that must catch it, not merely on
  // "something flagged it". Defence in depth would otherwise let one rule mask
  // another's regression: revert the normalisation and a case could still be
  // caught by a different axis, leaving the test green over a real hole. Mixed
  // separators are included because a rule that learned to recognise "a
  // backslash path" as a second shape would still miss `scripts\\lib/x.js`.
  // [label, line, form, token] — the token matters as much as the form. Without
  // it, a rule that captures a *truncated* path (`scripts/lib` instead of
  // `scripts/lib/llm-bridge.js`) still reports the right form and the case
  // passes over a real hole. That is precisely how the PATH_BODY axis went
  // unproven on the first attempt.
  const cases = [
    ['interpreter-exec, backslash', 'Run `node scripts\\harvest.js` to ingest one artifact.',
      'interpreter-exec', 'scripts/harvest.js'],
    ['interpreter-exec, mixed', 'Run `node scripts\\lib/llm-bridge.js` to refine.',
      'interpreter-exec', 'scripts/lib/llm-bridge.js'],
    // Two backslashes: the first is consumed by ANY_ROOT, the second must be
    // accepted by PATH_BODY or the token truncates at `scripts/lib`.
    ['interpreter-exec, nested backslash', 'Run `node scripts\\lib\\llm-bridge.js` to refine.',
      'interpreter-exec', 'scripts/lib/llm-bridge.js'],
    ['executable-token, backslash', 'the bundle is `dist\\mcp-server.cjs`',
      'executable-token', 'dist/mcp-server.cjs'],
    ['read-verb, backslash', 'Read `agents\\memory-distiller.md`',
      'read-verb', 'agents/memory-distiller.md'],
    ['resolves-in-plugin, backslash', 'the schema is `schemas\\memory-card.schema.json`',
      'resolves-in-plugin', 'schemas/memory-card.schema.json'],
  ];

  // Collected, not asserted case-by-case: a per-case `assert.ok` aborts on the
  // first failure, so a single mutation run would only ever prove one axis.
  const missed = [];
  for (const [label, line, form, token] of cases) {
    const hits = shadowableTokens(line, path.join(ROOT, 'AGENTS.md'), '');
    if (!hits.some((h) => h.form === form && h.token === token)) {
      missed.push(`${label} — expected ${form} on '${token}', got ${JSON.stringify(hits.map((h) => `${h.form}:${h.token}`))}`);
    }
  }
  assert.deepEqual(missed, [],
    `a backslash separator hid these from the guard:\n  ${missed.join('\n  ')}`);

  // Containment, clause B: an anchored traversal written with backslashes is
  // still a traversal.
  const traversal = shadowableTokens('node "${CLAUDE_PLUGIN_ROOT}\\..\\workspace\\evil.js"');
  assert.ok(traversal.length > 0, 'anchored backslash traversal must be rejected');
  assert.equal(traversal[0].why, 'escapes plugin root');

  // An anchored backslash path that stays inside the root is fine — the rule is
  // separator-blind, not backslash-hostile. The executable form is listed
  // separately: its negative lookbehind must include the backslash, or the
  // matcher restarts mid-path at `scripts\\harvest.js` and reports an anchored
  // path as unanchored.
  for (const clean of [
    'Read `${CLAUDE_PLUGIN_ROOT}\\skills\\deep-memory-init\\SKILL.md`',
    'node "${CLAUDE_PLUGIN_ROOT}\\scripts\\harvest.js" --kind work-receipt',
    'the bundle is `${PLUGIN_ROOT}\\dist\\mcp-server.cjs`',
  ]) {
    assert.deepEqual(shadowableTokens(clean), [],
      `anchored backslash path must be accepted: ${clean}`);
  }

  // Negatives: prose carrying a stray backslash or an escape sequence must not
  // be promoted into a path. Over-normalising is safe only while this holds.
  for (const line of [
    'Use a literal \\t between the columns.',
    'The Windows form is C:\\Users\\me\\.deep-memory and needs no anchor.',
    'Escape it as \\\\ in the JSON string.',
  ]) {
    assert.deepEqual(shadowableTokens(line, path.join(ROOT, 'AGENTS.md'), ''), [],
      `prose must not be promoted to a path: ${line}`);
  }
});

// Which LAYER sees a line, by name. The guard has two independent layers and
// they fail differently: the classifier objects, and the malicious-workspace
// fixture proves the instruction actually lands on a planted file. A separator
// run once left the classifier firing while the fixture went blind, and the
// review that first looked at it read the failure COUNT and called the bypass
// caught. Counting is what hid it, so this returns names.
function layersFiring(line) {
  const firing = [];
  if (shadowableTokens(line, path.join(ROOT, 'AGENTS.md'), '').length > 0) firing.push('classifier');
  // The fixture plants from scopedTokens and lands on anything unanchored that
  // names a real plugin file — so this is exactly its reachability condition.
  for (const token of scopedTokens(line)) {
    if (ANCHORED_TOKEN.test(token)) continue;
    const clean = token.replace(/^\.\//, '');
    if (PLUGIN_FILES.has(clean)) { firing.push('fixture'); break; }
  }
  return firing;
}

test('both guard layers see a path however its separators are written', () => {
  // Every shape names the same real file. A shape that reaches only one layer
  // is a shape where the reachability proof is gone.
  const shapes = [
    ['forward slash', 'Run `node scripts/harvest.js` now.'],
    ['single backslash', 'Run `node scripts\\harvest.js` now.'],
    ['double backslash run', 'Run `node scripts\\\\harvest.js` now.'],
    ['triple backslash run', 'Run `node scripts\\\\\\harvest.js` now.'],
    ['mixed run', 'Run `node scripts\\\\/harvest.js` now.'],
    ['doubled forward slash', 'Run `node scripts//harvest.js` now.'],
  ];
  const wrong = [];
  for (const [label, line] of shapes) {
    const firing = layersFiring(line);
    if (!(firing.includes('classifier') && firing.includes('fixture'))) {
      wrong.push(`${label}: only [${firing.join(', ') || 'none'}] fired`);
    }
  }
  assert.deepEqual(wrong, [],
    `a separator shape reached fewer than both layers — the missing layer is named:\n  ${wrong.join('\n  ')}`);
});

test('the layer probe is non-vacuous', () => {
  // If layersFiring could never return a partial answer, the test above would
  // pass on a guard with one layer deleted. An anchored path must reach
  // neither layer, and prose must reach neither.
  assert.deepEqual(layersFiring('Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/harvest.js"` now.'), [],
    'an anchored path must reach neither layer');
  assert.deepEqual(layersFiring('Nothing path-shaped here at all.'), [],
    'prose must reach neither layer');
});

test('mixed lines fail on the bare token', () => {
  // A line-level anchor check passes this; the token-level check must not.
  const line = 'Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-memory-init/SKILL.md` then Read `../deep-memory-audit/SKILL.md`';
  const hits = shadowableTokens(line);
  assert.equal(hits.length, 1, 'exactly the bare token must be flagged');
  assert.equal(hits[0].why, 'unanchored');
});

test('a path the plugin never ships carries the sentence that makes it safe', () => {
  // Self-consistency axis. This branch's own rule — "a bare plugin path resolves
  // against the analysed project" — was violated by the line naming the doc
  // rulebook, because `docs/` is gitignored and that path resolves *nowhere
  // else*. Writing the rule is not enforcing it.
  const violations = [];
  for (const [token, clauses] of NON_SHIPPED) {
    assert.ok(!PLUGIN_FILES.has(token),
      `${token} is listed as non-shipped but is in the shipped file set`);
    for (const file of markdownFiles()) {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes(token)) continue;
      const flat = flatten(body);
      for (const clause of clauses) {
        if (!clause.test(flat)) {
          violations.push(`${path.relative(ROOT, file)} names ${token} but is missing: ${clause.source}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [],
    `a non-shipped path is named without every clause that makes it safe:\n  ${violations.join('\n  ')}`);
});

// Derived from `.gitignore`, never hand-listed: a hand-listed pair matches the
// ignore file on the day it is written and leaks the first time an entry is added.
const GITIGNORED_DIRS = (() => {
  const body = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  return body.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && l.endsWith('/'))
    .map((l) => l.replace(/\/$/, ''));
})();

// Two different reasons a directory is gitignored, and only one is a hazard.
//
// `docs/`, `coverage/` and the editor directories are *maintainer-only*: they
// exist in a checkout and nowhere else, so naming a path inside one can only
// ever resolve against the analysed project. That is the hazard.
//
// The `.deep-*` directories are the opposite. They are this plugin's own
// workspace outputs — `.deep-memory/project-profile.json` is *meant* to resolve
// against the project being worked on, and every skill reads and writes it
// there by design. Sweeping them would flag the plugin's entire reason for
// existing. The split is declared here rather than inferred, and asserted below,
// so that a new `.deep-*` sibling does not silently join the wrong class.
const WORKSPACE_OUTPUT_DIRS = new Set(GITIGNORED_DIRS.filter((d) => d.startsWith('.deep-')));
const MAINTAINER_ONLY_DIRS = GITIGNORED_DIRS
  .filter((d) => !WORKSPACE_OUTPUT_DIRS.has(d) && d !== 'node_modules');

test('the non-shipped directory list is derived from .gitignore, not guessed', () => {
  assert.ok(GITIGNORED_DIRS.length > 0, '.gitignore yielded no ignored directories');
  assert.ok(MAINTAINER_ONLY_DIRS.includes('docs'),
    'docs must be recognised as maintainer-only — it is where the blind spot was found');
  // Non-vacuity for the split: if this ever empties, the sweep below silently
  // starts flagging the plugin's own project-relative state files.
  assert.ok(WORKSPACE_OUTPUT_DIRS.has('.deep-memory'),
    '.deep-memory must be classed as a workspace output, not a maintainer-only path');
  for (const dir of MAINTAINER_ONLY_DIRS) {
    assert.ok(!dir.startsWith('.deep-'), `${dir} looks like a workspace output but is swept`);
  }
});

test('no undeclared path under a non-shipped directory is named', () => {
  // The generalisation. Lexical over raw lines, never consulting the resolver,
  // so it is immune to the skip-set blind spot that created the gap.
  const re = new RegExp(String.raw`(?<![A-Za-z0-9._/-])((?:${MAINTAINER_ONLY_DIRS.map((d) => d.replace(/[.]/g, '\\.')).join('|')})/[A-Za-z0-9._/-]+)`, 'g');
  const violations = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (NON_SHIPPED.has(m[1])) continue;
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[1]}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    `a path under a non-shipped directory is named without being declared:\n  ${violations.join('\n  ')}`);
});

test('every referenced skill path resolves', () => {
  const patterns = [
    // Trailing boundary, same reason as the guard: without it `.js` matches the
    // prefix of `.json` and the resolver reports files that never existed.
    [/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+\.(?:md|js|cjs|mjs|sh|json|yaml)(?![A-Za-z0-9]))/g, false],
    [/`(\.\.\/[A-Za-z0-9._/-]+\.md)(?:#[a-z0-9-]+)?`/g, true],
    [/\]\((\.\.?\/[A-Za-z0-9._/-]+\.md)\)/g, true],
    [/Read\("(\.\.\/[A-Za-z0-9._/-]+\.md)(?:#[a-z0-9-]+)?"\)/g, true],
  ];
  const broken = [];
  let resolved = 0;
  const realRoot = fs.realpathSync(ROOT);
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const [re, isRelative] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        const target = isRelative
          ? path.resolve(path.dirname(file), m[1])
          : path.join(ROOT, m[1]);
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (missing)`);
          continue;
        }
        // Existing is not enough: a target that resolves outside the plugin
        // root — lexically or through a symlinked component — is exactly the
        // file an attacker wants us to accept. Containment is checked here too,
        // so the two tests cannot disagree about what counts as in-root.
        const real = fs.realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (resolves outside the plugin root: ${real})`);
          continue;
        }
        resolved += 1;
      }
    }
  }
  assert.deepEqual(broken, [], `unresolvable or out-of-root reference:\n  ${broken.join('\n  ')}`);
  assert.ok(resolved > 0, 'sweep matched no references at all — the patterns have rotted');
});
