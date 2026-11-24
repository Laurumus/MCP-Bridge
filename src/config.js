import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * - unset / empty / whitespace -> null: use the model OpenCode itself selects
 *   for the new session (its configured default). The bridge never invents a
 *   provider or model; the caller is told which model was actually chosen.
 * - otherwise: a `provider/model` reference (optional `#variant`). Whether it
 *   is valid is decided by parseModelRef() in opencode-api.js.
 */
export function parseExecutorModelSetting(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

export const config = {
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: num(process.env.BRIDGE_PORT, 9999),

  dbPath: process.env.BRIDGE_DB_PATH || path.join(BRIDGE_DIR, 'tasks.db'),
  tokenFile: process.env.BRIDGE_TOKEN_FILE || path.join(BRIDGE_DIR, '.bearer_token'),
  logFile: process.env.BRIDGE_LOG_FILE || path.join(BRIDGE_DIR, 'bridge.log'),

  // The executor agent and model are set locally, never from the client.
  // executorModel === null means "use the model OpenCode selects by default".
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
