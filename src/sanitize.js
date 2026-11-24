/**
 * Best-effort secret redaction for text that is handed to an MCP client or to
 * the local log (e.g. a short tool-error explanation).
 *
 * This is NOT a guarantee of anonymity for arbitrary text. It recognises a
 * fixed set of common shapes -- `Authorization: <value>`, `Bearer <value>`,
 * `Basic <value>`, `api_key`/`api-key`/`apiToken`/`token`/`password`-style
 * `key=value` (or `key: value`) pairs, and well-known key prefixes (`sk-...`)
 * -- and replaces the secret part with `[REDACTED]`. Text that does not match
 * one of these shapes is left as is, so callers must still treat the output as
 * potentially sensitive and keep it small (see `redactToolError`).
 */

export const REDACTED = '[REDACTED]';

// A single secret-looking token: no whitespace/control chars, at most 4096
// characters, so an unbounded blob never drives the regular expressions.
const TOKEN = "[^\\s\"'`,;\\u0000-\\u001f]{1,4096}";

/** Matches that replace a named credential with a redacted form. */
const PATTERNS = [
  // Authorization: Bearer abc / "authorization":"Bearer abc" / proxy-authorization
  [new RegExp(`((?:proxy-)?authorization)("?\\s*[:=]\\s*"?)(bearer|basic|token|digest)\\s+${TOKEN}`, 'gi'),
    (_m, key, sep, scheme) => `${key}${sep}${scheme} ${REDACTED}`],
  // Authorization: <raw value>
  [new RegExp(`((?:proxy-)?authorization)("?\\s*[:=]\\s*"?)(?!\\[REDACTED\\])${TOKEN}`, 'gi'),
    (_m, key, sep) => `${key}${sep}${REDACTED}`],
  // Bare "Bearer <value>" anywhere in the text.
  [new RegExp(`\\b(bearer)\\s+${TOKEN}`, 'gi'), (_m, scheme) => `${scheme} ${REDACTED}`],
  // Well-known API key prefixes (OpenAI-style sk-, GitHub, AWS, Slack).
  [/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, `gh_${REDACTED}`],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, `github_pat_${REDACTED}`],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, `AKIA${REDACTED}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, `xox-${REDACTED}`],
  // Explicit key/value pairs. The key must look like a credential name; the
  // separator may be `=` or `:`, the value may be quoted.
  [new RegExp(`((?:[\\w.-]*[_.-])?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|pwd|passphrase))("?\\s*[:=]\\s*"?)(${TOKEN})`, 'gi'),
    (_m, key, sep) => `${key}${sep}${REDACTED}`],
];

/**
 * Redact recognisable secrets in `text`. Non-string input is converted with
 * `String()` only for primitives; objects are not stringified here (callers
 * narrow the value first). Never throws.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [re, repl] of PATTERNS) {
    try {
      out = out.replace(re, repl);
    } catch {
      // A pathological input must never break result delivery.
    }
  }
  return out;
}
