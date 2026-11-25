/** Best-effort redaction; arbitrary text can still contain sensitive data. */
export const REDACTED = '[REDACTED]';
export const MAX_DIAGNOSTIC_INPUT_LENGTH = 16384;

// Regex literals avoid a second layer of template-string backslash escaping.
const AUTH = /(\b(?:proxy-)?authorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|["'][^\r\n]*|(?:bearer|basic|token|digest)\s+[^\s"'`,;]+|[^\s"'`,;]+)/gi;
const NAMED = /(\b(?:[\w.-]*[_.-])?(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|pwd|passphrase)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|["'][^\r\n]*|[^\s"'`,;]+)/gi;
const BEARER = /\bbearer\s+[^\s"'`,;]+/gi;
const PREFIXES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  if (text.length > MAX_DIAGNOSTIC_INPUT_LENGTH) return `${REDACTED} oversized diagnostic`;
  try {
    let out = text.replace(AUTH, (_match, label) => `${label}${REDACTED}`);
    out = out.replace(NAMED, (_match, label) => `${label}${REDACTED}`);
    out = out.replace(BEARER, `Bearer ${REDACTED}`);
    for (const pattern of PREFIXES) out = out.replace(pattern, REDACTED);
    return out;
  } catch {
    return REDACTED;
  }
}
