'use strict';
const os = require('os');

const REDACT_TAG = '[REDACTED]';

/**
 * 7 deny-patterns covering common credential, PII, network, and infra exposure:
 *   1. credential assignments (api_key=, token:, secret=, bearer, password=, passwd=, pwd=)
 *   2. email addresses
 *   3. database/queue connection URIs (postgres / mysql / mongodb / redis / amqp / postgresql)
 *   4. RFC1918 10.0.0.0/8
 *   5. RFC1918 192.168.0.0/16
 *   6. RFC1918 172.16.0.0/12
 *   7. internal hostnames (.internal / .local / .lan)
 *
 * Note: the credential pattern is intentionally greedy on the value side to mask the
 * entire token even when it contains URL-safe characters. The HOME_RE replacement is
 * applied first so that `/Users/<name>/...` collapses to `~/...` (PII-safe).
 */
const DENY_PATTERNS = [
  /(?:api[_-]?key|token|secret|bearer|password|passwd|pwd)[\s:=]+["']?[A-Za-z0-9_\-+/]{12,}/gi,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)(?:ql)?:\/\/[^\s'"<>]+/gi,
  /\b10\.\d+\.\d+\.\d+\b/g,
  /\b192\.168\.\d+\.\d+\b/g,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b/g,
  /\b[A-Za-z0-9_-]+\.(?:internal|local|lan|dev)\b/gi,
];

// Complete native-Windows absolute path forms. Extended/device prefixes must
// run before ordinary UNC/drive forms. Drive-relative `C:notes\todo.txt` does
// not match because the drive rule requires a backslash after the colon.
const WINDOWS_ABSOLUTE_PATH_START_RE =
  /(?:\\{2,}\?\\+(?:UNC\\+|[A-Za-z]:\\+)|\\{2,}\.\\+|\\{2,}(?![?.])[^\\\s"'<>|]+\\+|(?<![A-Za-z0-9_])[A-Za-z]:\\+)/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERNS = [WINDOWS_ABSOLUTE_PATH_START_RE];

function isSingleQuoteClosureFollower(input, index) {
  if (index >= input.length) return true;
  const ch = input[index];
  return /\s/.test(ch) || '"<>|,;:.!?)]}'.includes(ch);
}

// A Windows filename may legally contain spaces, so whitespace cannot be the
// end delimiter. MCP values reach this function as either a complete string
// leaf, a quoted JSON/YAML value, a line field, or a ` | `-joined diagnostic.
// Stop only at those structural delimiters; for otherwise-unquoted prose we
// conservatively redact the remainder instead of leaking a path suffix.
function redactWindowsAbsolutePaths(input) {
  const re = new RegExp(WINDOWS_ABSOLUTE_PATH_START_RE.source, WINDOWS_ABSOLUTE_PATH_START_RE.flags);
  let output = '';
  let cursor = 0;
  for (let match = re.exec(input); match; match = re.exec(input)) {
    output += input.slice(cursor, match.index);
    let contextIndex = match.index - 1;
    while (contextIndex >= 0 && (input[contextIndex] === ' ' || input[contextIndex] === '\t')) {
      contextIndex -= 1;
    }
    const quoteContext = input[contextIndex] === '"' || input[contextIndex] === "'"
      ? input[contextIndex]
      : null;
    let end = match.index + match[0].length;
    let lastSingleQuoteClosure = -1;
    while (end < input.length) {
      const ch = input[end];
      if (quoteContext === "'" && ch === "'") {
        // YAML single-quoted scalars escape a literal apostrophe as two
        // adjacent apostrophes. Both characters are part of the path; only an
        // unmatched apostrophe closes the scalar.
        if (input[end + 1] === "'") {
          end += 2;
          continue;
        }
        // Native fs/OS diagnostics quote raw filenames without YAML-escaping
        // a legal apostrophe inside the path. Treat only the last structurally
        // plausible singleton as the closer; otherwise keep masking until a
        // hard delimiter. YAML doubled apostrophes remain non-candidates.
        if (isSingleQuoteClosureFollower(input, end + 1)) lastSingleQuoteClosure = end;
        end += 1;
        continue;
      }
      if (quoteContext === '"' && ch === '"') break;
      if (quoteContext === "'" && ch === '"') break;
      if (quoteContext === null && ch === '"') break;
      if (ch === '<' || ch === '>' || ch === '\r' || ch === '\n') break;
      if (input.startsWith(' | ', end)) break;
      end += 1;
    }
    if (quoteContext === "'" && lastSingleQuoteClosure >= 0) end = lastSingleQuoteClosure;
    output += REDACT_TAG;
    cursor = end;
    re.lastIndex = end;
  }
  return output + input.slice(cursor);
}

// PR1-E (R-011) — env-var assignment masking. Matches `$VAR`, `process.env.VAR`,
// `export VAR=...`, and BARE `VAR=...` (W3 bare-assignment fix). Value is
// replaced with <REDACTED>; variable name preserved for context. Only
// sensitive prefixes (AGENTMEMORY/AWS/OPENAI/ANTHROPIC/GOOGLE/STRIPE/GITHUB)
// are covered to avoid masking unrelated env vars (PATH, etc.).
const SENSITIVE_VAR_RE = /((?:\$|process\.env\.|\bexport\s+)?(?:AGENTMEMORY|AWS|OPENAI|ANTHROPIC|GOOGLE|STRIPE|GITHUB)_[A-Z_]+)(\s*=\s*['"]?[\w./+\-]+['"]?)?/g;

const HOME_RE = new RegExp(
  os.homedir().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
  'g'
);

// PR1-E (R-011) (a) — generic homedir → `~` for ANY user (macOS + Linux).
// HOME_RE only covers the current runner; this rule covers /Users/alice or
// /home/runner regardless of who ran the process. Applied BEFORE DENY_PATTERNS.
function applyGenericHomedir(s) {
  return s
    .replace(/\/Users\/[a-zA-Z0-9_.-]+/g, '~')      // macOS
    .replace(/\/home\/[a-zA-Z0-9_.-]+/g, '~');      // Linux
}

// PR1-E (R-011) (b) — env-var value masking that PRESERVES the variable name.
function applyEnvVarRedaction(s) {
  return s.replace(SENSITIVE_VAR_RE, (_m, varRef, assignment) =>
    assignment ? `${varRef}=<REDACTED>` : varRef);
}

/**
 * Mask any matched DENY_PATTERN segment with REDACT_TAG and collapse home directory
 * to `~`. If `allowPatterns` are provided, any redacted span that overlaps the allow
 * pattern is restored — used to un-mask user-defined whitelist entries (e.g. test
 * fixture tags that must survive redaction).
 *
 * PR1-E pipeline stage order:
 *   1) HOME_RE (current runner homedir → ~)
 *   2) applyGenericHomedir (any /Users/<name>/ or /home/<name>/ → ~)
 *   3) applyEnvVarRedaction (sensitive env-var value → <REDACTED>, name preserved)
 *   4) WINDOWS_ABSOLUTE_PATH_PATTERNS (native absolute paths → REDACT_TAG)
 *   5) DENY_PATTERNS (credentials, email, db-URI, RFC1918, internal hosts → REDACT_TAG)
 *   6) allowPatterns restoration (existing v0.1.x logic, unchanged)
 */
function redactString(input, { allowPatterns = [] } = {}) {
  if (typeof input !== 'string') return input;
  let out = input.replace(HOME_RE, '~');     // 1: current homedir
  out = applyGenericHomedir(out);            // 2: PR1-E (a)
  out = applyEnvVarRedaction(out);           // 3: PR1-E (b)
  out = redactWindowsAbsolutePaths(out);       // 4: native Windows paths
  for (const re of DENY_PATTERNS) {          // 5: existing patterns
    out = out.replace(re, REDACT_TAG);
  }
  for (const allow of allowPatterns) {       // 6: existing allow logic
    const allowRe = new RegExp(allow, 'g');
    if (allowRe.test(input)) {
      const matches = input.match(allowRe) || [];
      for (const m of matches) {
        out = out.replace(REDACT_TAG, m);
      }
    }
  }
  return out;
}

/**
 * Deep-recurse a value, applying redactString to every string leaf. Non-string scalars
 * (number / boolean / null / undefined) pass through unchanged. Arrays preserve order;
 * objects preserve key order via Object.keys iteration.
 */
function redactObject(value, opts = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, opts));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactObject(value[k], opts);
    return out;
  }
  return value;
}

module.exports = {
  redactString,
  redactObject,
  REDACT_TAG,
  DENY_PATTERNS,
  WINDOWS_ABSOLUTE_PATH_PATTERNS,
  redactWindowsAbsolutePaths,
  HOME_RE,
};
