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

const HOME_RE = new RegExp(
  os.homedir().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
  'g'
);

/**
 * Mask any matched DENY_PATTERN segment with REDACT_TAG and collapse home directory
 * to `~`. If `allowPatterns` are provided, any redacted span that overlaps the allow
 * pattern is restored — used to un-mask user-defined whitelist entries (e.g. test
 * fixture tags that must survive redaction).
 */
function redactString(input, { allowPatterns = [] } = {}) {
  if (typeof input !== 'string') return input;
  let out = input.replace(HOME_RE, '~');
  for (const re of DENY_PATTERNS) {
    out = out.replace(re, REDACT_TAG);
  }
  for (const allow of allowPatterns) {
    const allowRe = new RegExp(allow, 'g');
    if (allowRe.test(input)) {
      const matches = input.match(allowRe) || [];
      for (const m of matches) {
        // restore first REDACT_TAG occurrence — best-effort false-positive correction
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
