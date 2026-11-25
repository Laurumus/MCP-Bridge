import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModelRef, describeModelRef } from './opencode-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_DIR = path.resolve(__dirname, '..');

/** Loopback hosts a bridge may expose its Bearer-protected endpoint on. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalize the executor model setting.
 *
 * - unset / empty / whitespace / non-string -> null, meaning "not configured".
 *   The bridge does NOT fall back to a model chosen by OpenCode: a configured
 *   model is mandatory, so a null result is a configuration error (reported by
 *   validateExecutorModel() and refused by the executor).
 * - otherwise: the trimmed `provider/model` reference (optional `#variant`).
 *
 * Syntax is validated separately by parseModelRef() in opencode-api.js.
 */
export function parseExecutorModelSetting(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate the mandatory executor model setting at startup.
 *
 * Returns `{ ok: true, model }` with the normalized reference, or
 * `{ ok: false, message }` with a clear, secret-free explanation for
 * BRIDGE_EXECUTOR_MODEL being missing, empty or malformed. There is no
 * fallback: the bridge must not run without an explicit model.
 *
 * The rejected value itself is NEVER echoed into the message: a mistyped
 * `provider/model` setting can be an accidentally pasted credential.
 *
 * The value is validated exactly as passed (no `process.env` default): the
 * caller decides where it comes from, which keeps `undefined` an error.
 */
export function validateExecutorModel(value) {
  const hint = 'Set BRIDGE_EXECUTOR_MODEL to a "provider/model" reference'
    + ' (optionally "provider/model#variant"), e.g. apmix/deepseek-v4.1-flash-1017.';
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, message: `BRIDGE_EXECUTOR_MODEL is required but ${value === undefined ? 'unset' : 'empty'}. ${hint}` };
  }
  const ref = parseModelRef(value);
  if (!ref) {
    return { ok: false, message: `BRIDGE_EXECUTOR_MODEL is not a valid model reference (value not shown). ${hint}` };
  }
  return { ok: true, model: describeModelRef(ref) };
}

/**
 * The bridge listens on loopback by default. BRIDGE_HOST may be another
 * loopback name (127.0.0.1, ::1, localhost) or an explicit address. Exposing it
 * further carries no TLS and no client isolation; the startup path logs a loud
 * warning for any non-loopback value instead of failing, so a proxy setup
 * stays possible.
 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.includes(String(host ?? '').toLowerCase());
}

/**
 * Warning text for a non-loopback BRIDGE_HOST, or null for a loopback one.
 *
 * The bridge exposes tool execution guarded only by a Bearer token, and a
 * non-loopback address has no TLS and no client isolation. This returns a
 * human-readable warning naming the host; the startup path logs it without
 * blocking. It takes only the host: the token and every other secret are
 * deliberately out of reach, so no secret value can leak into the message.
 */
export function nonLoopbackHostWarning(host) {
  if (isLoopbackHost(host)) return null;
  const shown = String(host ?? '').trim() || '(empty)';
  return `WARNING: BRIDGE_HOST=${shown} is not a loopback address.`
    + ' The bridge lets anyone holding the Bearer token execute tools.'
    + ' This address has no TLS and no client isolation, so protect both the'
    + ' traffic and the token (TLS / reverse proxy / firewall).'
    + ' Startup continues; this is a warning, not a fatal error.';
}

export const config = {
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: num(process.env.BRIDGE_PORT, 9999),

  dbPath: process.env.BRIDGE_DB_PATH || path.join(BRIDGE_DIR, 'tasks.db'),
  tokenFile: process.env.BRIDGE_TOKEN_FILE || path.join(BRIDGE_DIR, '.bearer_token'),
  logFile: process.env.BRIDGE_LOG_FILE || path.join(BRIDGE_DIR, 'bridge.log'),

  // The executor agent and model are set locally, never from the client.
  // executorModel is REQUIRED (validateExecutorModel); null means it is
  // missing or blank, which the executor refuses as a configuration error.
  // This module never falls back to a model inherited from OpenCode.
  executorAgent: process.env.BRIDGE_EXECUTOR_AGENT || 'executor',
  executorModel: parseExecutorModelSetting(process.env.BRIDGE_EXECUTOR_MODEL),
  // Absolute directory requested for each task's OpenCode session
  // (`POST /api/session` -> `location.directory`).
  workdir: path.resolve(process.env.BRIDGE_WORKDIR || BRIDGE_DIR),

  opencodeApiTimeoutMs: num(process.env.BRIDGE_OPENCODE_API_TIMEOUT_MS, 30000),
  taskExecutionTimeoutMs: num(process.env.BRIDGE_TASK_EXECUTION_TIMEOUT_MS, 300000),
  watchdogIntervalMs: num(process.env.BRIDGE_WATCHDOG_INTERVAL_MS, 3000),

  maxPromptLength: num(process.env.BRIDGE_MAX_PROMPT_LENGTH, 10000),
  maxResultLength: num(process.env.BRIDGE_MAX_RESULT_LENGTH, 50000),
  maxRequestBodySize: num(process.env.BRIDGE_MAX_REQUEST_BODY_SIZE, 1024 * 1024),
  maxSessions: num(process.env.BRIDGE_MAX_SESSIONS, 100),
};
