import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

/**
 * Load the bridge's own random Bearer token, creating it once with 0600
 * permissions if absent. This token is independent of any OpenCode, HA,
 * Proxmox or other service token.
 */
export function loadOrCreateToken(tokenFile) {
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return token;
}

/**
 * Constant-time Bearer-token verifier over the Authorization header.
 */
export class BearerAuth {
  constructor(token) {
    this._tokenBuf = Buffer.from(token, 'utf8');
  }

  verify(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return false;
    const provided = Buffer.from(m[1], 'utf8');
    if (provided.length !== this._tokenBuf.length) return false;
    return timingSafeEqual(provided, this._tokenBuf);
  }
}
