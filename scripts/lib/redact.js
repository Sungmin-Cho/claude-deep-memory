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
 *   4) DENY_PATTERNS (credentials, email, db-URI, RFC1918, internal hosts → REDACT_TAG)
 *   5) allowPatterns restoration (existing v0.1.x logic, unchanged)
 */
function redactString(input, { allowPatterns = [] } = {}) {
  if (typeof input !== 'string') return input;
  let out = input.replace(HOME_RE, '~');     // 1: current homedir
  out = applyGenericHomedir(out);            // 2: PR1-E (a)
  out = applyEnvVarRedaction(out);           // 3: PR1-E (b)
  for (const re of DENY_PATTERNS) {          // 4: existing patterns
    out = out.replace(re, REDACT_TAG);
  }
  for (const allow of allowPatterns) {       // 5: existing allow logic
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

module.exports = { redactString, redactObject, REDACT_TAG, DENY_PATTERNS, HOME_RE };
