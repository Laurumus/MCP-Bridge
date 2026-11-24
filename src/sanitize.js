/** Best-effort redaction, not a guarantee that arbitrary text is public-safe. */
export const REDACTED = '[REDACTED]';
export const MAX_DIAGNOSTIC_INPUT_LENGTH = 16384;

// Match whole quoted values, including escaped quotes and whitespace. If a
// quote is unterminated, discard the remainder rather than expose a suffix.
const QUOTED = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const RAW = String.raw`[^\s"'\x60,;]+`;
const VALUE = `(?:${QUOTED}|${RAW}|["'][^\r\n]*)`;
const AUTH_VALUE = `(?:${QUOTED}|(?:bearer|basic|token|digest)\s+${RAW}|${RAW}|["'][^\r\n]*)`;
const AUTH = new RegExp(`(\b(?:proxy-)?authorization["']?\s*[:=]\s*)${AUTH_VALUE}`, 'gi');
const NAMED = new RegExp(
  `(\b(?:[\w.-]*[_.-])?(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|pwd|passphrase)["']?\s*[:=]\s*)${VALUE}`,
  'gi',
);
const BEARER = new RegExp(`\bbearer\s+${RAW}`, 'gi');
const PREFIXES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  // Do not cut a credential in half and expose the surviving suffix.
  if (text.length > MAX_DIAGNOSTIC_INPUT_LENGTH) return `${REDACTED} oversized diagnostic`;
  try {
    let out = text.replace(AUTH, (_match, label) => `${label}${REDACTED}`);
    out = out.replace(NAMED, (_match, label) => `${label}${REDACTED}`);
    out = out.replace(BEARER, `Bearer ${REDACTED}`);
    for (const pattern of PREFIXES) out = out.replace(pattern, REDACTED);
    return out;
  } catch {
    // Fail closed: an unexpected redaction failure must not return raw text.
    return REDACTED;
  }
}
