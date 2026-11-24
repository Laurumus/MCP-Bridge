import { appendFileSync } from 'node:fs';
import { config, validateExecutorModel } from './config.js';
import { Store } from './store.js';
import { OpenCodeAPI } from './opencode-api.js';
import { Executor } from './executor.js';
import { BearerAuth, loadOrCreateToken } from './auth.js';
import { startServer } from './server.js';

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(config.logFile, line);
  } catch {
    // logging must never fail the bridge
  }
  process.stderr.write(line);
}

async function main() {
  // Fail fast on a missing/empty/invalid executor model BEFORE anything is
  // created: no log file, no token file, no database, no recovery, no API
  // call. The model is mandatory; there is no inherited fallback.
  const modelCheck = validateExecutorModel(config.executorModel);
  if (!modelCheck.ok) {
    throw new Error(`configuration error: ${modelCheck.message}`);
  }
  config.executorModel = modelCheck.model;

  const token = loadOrCreateToken(config.tokenFile); // value is never logged
  log('opencode-mcp-bridge starting');
  log(`executor model: ${config.executorModel}`);

  const store = new Store(config.dbPath);
  const executor = new Executor({
    api: OpenCodeAPI,
    store,
    config,
  });

  // Reconcile any tasks left running by a previous process.
  try {
    await executor.recover();
  } catch (e) {
    log(`recovery error: ${e.message}`);
  }

  const readiness = await executor.verifyReady();
  if (readiness.ok) {
    log(`executor mode: ${readiness.mode} (${readiness.mode === 'full' ? 'tools enabled' : 'deny-all, text-only'})`);
  } else {
    log(`executor unavailable: ${readiness.reason}`);
    log('submit_task will refuse submissions until the executor agent is available');
  }

  const auth = new BearerAuth(token);
  const { close } = await startServer({ executor, auth, config, log });
  log(`listening on http://${config.host}:${config.port} (Streamable HTTP)`);

  const watchdog = setInterval(() => {
    executor.watchdogTick().catch((e) => log(`watchdog error: ${sanitize(e)}`));
  }, config.watchdogIntervalMs);

  async function shutdown(signal) {
    log(`received ${signal}, shutting down`);
    clearInterval(watchdog);
    try { await close(); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    process.exit(0);
  }

  function sanitize(value) {
    return String(value && value.stack ? value.stack : value).slice(0, 2000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
