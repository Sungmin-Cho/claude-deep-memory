'use strict';
const os = require('os');
const path = require('node:path');
const { NON_RESOLVABLE_PATH } = require('./path-utils');

const REDACT_TAG = NON_RESOLVABLE_PATH;

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
// run before ordinary UNC/drive forms. Both native separators are accepted;
// drive-relative `C:notes/todo.txt` does not match because the drive rule
// requires an immediate slash or backslash after the colon. Forward-slash UNC
// starts reject URI-scheme contexts such as `https://` via the lookbehind.
const WINDOWS_ABSOLUTE_PATH_START_RE =
  /(?:(?<![:A-Za-z0-9_])[\\/]{2,}\?[\\/]+(?=[^\\/\s"'<>|])|(?<![:A-Za-z0-9_])[\\/]{2,}\.[\\/]+|(?<![:A-Za-z0-9_])[\\/]{2,}(?![?.])[^\\/\s"'<>|]+[\\/]+|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+)/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERNS = [WINDOWS_ABSOLUTE_PATH_START_RE];
const EXTENDED_DRIVE_PREFIX_RE =
  /(?<![:A-Za-z0-9_])[\\/]{2,}\?[\\/]+(?=[A-Za-z]:[\\/]+)/gi;

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

function escapeRegex(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function escapeWindowsPathRegex(value) {
  let source = '';
  let inSeparator = false;
  for (const character of value) {
    if (character === '\\' || character === '/') {
      if (!inSeparator) source += '[\\\\/]+';
      inSeparator = true;
    } else {
      source += escapeRegex(character);
      inSeparator = false;
    }
  }
  return source;
}

function createHomeRegex(homeDir, platform = process.platform) {
  return new RegExp(
    `${platform === 'win32' ? escapeWindowsPathRegex(homeDir) : escapeRegex(homeDir)}(?=$|[\\\\/])`,
    platform === 'win32' ? 'gi' : 'g',
  );
}

const HOME_RE = createHomeRegex(os.homedir());

// PR1-E (R-011) (a) — generic homedir → `~` for ANY user (macOS + Linux).
// HOME_RE only covers the current runner; this rule covers /Users/alice or
// /home/runner regardless of who ran the process. Applied BEFORE DENY_PATTERNS.
function applyGenericHomedir(s) {
  return s
    .replace(/\/Users\/[a-zA-Z0-9_.-]+(?=$|[\\/])/g, '~')      // macOS
    .replace(/\/home\/[a-zA-Z0-9_.-]+(?=$|[\\/])/g, '~');      // Linux
}

function withoutExtendedDrivePrefix(value) {
  return value.replace(/^[\\/]{2,}\?[\\/]+(?=[A-Za-z]:[\\/]+)/i, '');
}

function normalizedPath(value, platform) {
  if (platform === 'win32') return path.win32.normalize(withoutExtendedDrivePrefix(value));
  return path.posix.normalize(value);
}

function collapseCurrentHomePath(value, { homeDir, platform }) {
  const candidate = normalizedPath(value, platform);
  const home = normalizedPath(homeDir, platform).replace(platform === 'win32' ? /\\+$/ : /\/+$/, '');
  const fold = (text) => platform === 'win32' ? text.toLowerCase() : text;
  if (fold(candidate) === fold(home)) return '~';
  const separator = platform === 'win32' ? '\\' : '/';
  if (fold(candidate).startsWith(`${fold(home)}${separator}`)) {
    return `~${candidate.slice(home.length)}`;
  }
  return null;
}

function isGenericUserHomePath(value, platform) {
  if (platform === 'win32') return /^[A-Za-z]:\\Users\\[^\\/\r\n"'<>|]+(?:\\|$)/i.test(value);
  return /^\/(?:Users|home)\/[^/]+(?:\/|$)/.test(value);
}

function containsSensitivePathData(value) {
  let sanitized = applyEnvVarRedaction(value);
  for (const re of DENY_PATTERNS) sanitized = sanitized.replace(re, REDACT_TAG);
  return sanitized !== value;
}

// Local provenance must remain usable by the audit path on Windows. Collapse
// user-home prefixes and secret-like values here, but reserve whole absolute
// Windows-path masking for the final MCP tool/resource boundary.
function redactPersistedPath(input, {
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (typeof input !== 'string') return input;
  if (input.includes(REDACT_TAG)) return REDACT_TAG;
  const effectivePlatform = platform === 'win32'
    || /^(?:[A-Za-z]:[\\/]|[\\/]{2,})/.test(input) ? 'win32' : platform;
  const comparable = normalizedPath(input, effectivePlatform);
  const collapsed = collapseCurrentHomePath(input, { homeDir, platform: effectivePlatform });
  if (collapsed !== null) return containsSensitivePathData(collapsed) ? REDACT_TAG : collapsed;
  if (isGenericUserHomePath(comparable, effectivePlatform)) return REDACT_TAG;
  if (containsSensitivePathData(input)) return REDACT_TAG;
  return input;
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
 *   2) WINDOWS_ABSOLUTE_PATH_PATTERNS (backslash or forward-slash native absolutes → REDACT_TAG)
 *   3) applyGenericHomedir (remaining POSIX /Users/<name>/ or /home/<name>/ → ~)
 *   4) applyEnvVarRedaction (sensitive env-var value → <REDACTED>, name preserved)
 *   5) DENY_PATTERNS (credentials, email, db-URI, RFC1918, internal hosts → REDACT_TAG)
 *   6) allowPatterns restoration (existing v0.1.x logic, unchanged)
 */
function redactString(input, {
  allowPatterns = [],
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (typeof input !== 'string') return input;
  // Canonicalize every separator-equivalent extended drive prefix before HOME
  // replacement. Otherwise `//?/C:/<HOME>/...` becomes `//?/~/...`, which no
  // longer looks like a Windows path at the final MCP boundary.
  let out = input.replace(EXTENDED_DRIVE_PREFIX_RE, '');
  out = out.replace(createHomeRegex(homeDir, platform), '~'); // 1: current homedir
  out = redactWindowsAbsolutePaths(out);      // 2: native Windows paths
  out = applyGenericHomedir(out);             // 3: PR1-E (a)
  out = applyEnvVarRedaction(out);            // 4: PR1-E (b)
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
  redactPersistedPath,
  HOME_RE,
};
