import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Store } from '../src/store.js';
import {
  Executor,
  mapOutcomeToStatus,
  classifyResultStatus,
  verifyExecutorReady,
  enforceResultBudget,
  BridgeError,
  AGENT_LOOKUP_RETRY_DELAYS_MS,
  AGENT_LOOKUP_MAX_ATTEMPTS,
} from '../src/executor.js';
import { OpenCodeError, classifyError, isAmbiguousError, isDefiniteRejection, parseModelRef, parseHttpStatus } from '../src/opencode-api.js';
import { BearerAuth } from '../src/auth.js';

const CONFIG = {
  workdir: '/tmp/opencode/bridge-workdir',
  executorAgent: 'executor',
  executorModel: 'apmix/deepseek-v4.1-flash-1017',
  opencodeApiTimeoutMs: 1000,
  taskExecutionTimeoutMs: 60_000,
  maxPromptLength: 10_000,
  maxResultLength: 50_000,
  // Fast retries in tests; the production default is AGENT_LOOKUP_RETRY_DELAYS_MS.
  agentLookupRetryDelaysMs: [0, 0, 0],
};

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-test-'));
  const store = new Store(path.join(dir, 'tasks.db'));
  return { dir, store };
}

/** Scripted fake of OpenCodeAPI for isolated, deterministic tests. */
class FakeApi {
  constructor() {
    this.calls = { createSession: 0, setAgent: 0, setModel: 0, sendPrompt: 0, getStatus: 0, interrupt: 0, getAgent: 0, evaluatePermission: 0 };
    this.sessionOutcome = null;
    this.sendPromptError = null;
    this.interrupted = true;
    this.interruptError = null;
    // Agent info returned by getAgent (for the readiness check). Default is a
    // full worker agent: base allow-all with no trailing deny-all.
    this.agent = { id: 'executor', mode: 'primary', permissions: [
      { action: '*', resource: '*', effect: 'allow' }, // base default
      { action: 'read', resource: '*.env', effect: 'ask' },
      { action: '*', resource: '*', effect: 'allow' }, // agent rule (full mode)
    ] };
    this.agentError = null;
    // Scripted per-call results for getAgent: each entry is either an Error to
    // throw or an agent object (or null) to return. Empties after use.
    this.getAgentQueue = null;
    // Session state returned by getStatus (agent/model confirmation).
    this.sessionAgent = 'executor';
    this.sessionModel = { id: 'deepseek-v4.1-flash-1017', providerID: 'apmix', variant: 'default' };
    // Arguments of the last createSession call (the executor must pass
    // `{ directory }`; the fixture mimics the real wrapper's object signature).
    this.lastCreateSession = null;
    this.probeEffect = 'allow';
    this.probeError = null;
  }
  async createSession({ directory } = {}) { this.calls.createSession++; this.lastCreateSession = { directory }; return { data: { id: 'ses_1' } }; }
  async setAgent() { this.calls.setAgent++; return {}; }
  async setModel() { this.calls.setModel++; return {}; }
  async sendPrompt() {
    this.calls.sendPrompt++;
    if (this.sendPromptError) throw this.sendPromptError;
    return { data: { id: 'msg_1' } };
  }
  async getStatus() {
    this.calls.getStatus++;
    return {
      data: {
        id: 'ses_1',
        agent: this.sessionAgent,
        model: this.sessionModel,
        outcome: this.sessionOutcome,
        cost: null,
        tokens: null,
      },
    };
  }
  async interrupt() {
    this.calls.interrupt++;
    if (this.interruptError) throw this.interruptError;
    return { interrupted: this.interrupted };
  }
  async getAgent() {
    this.calls.getAgent++;
    if (this.getAgentQueue && this.getAgentQueue.length > 0) {
      const next = this.getAgentQueue.shift();
      if (next instanceof Error) throw next;
      return { data: next };
    }
    if (this.agentError) throw this.agentError;
    return { data: this.agent };
  }
  async evaluatePermission(_sessionId, action, _resources, _agent) {
    this.calls.evaluatePermission++;
    if (this.probeError) throw this.probeError;
    return { data: { id: 'per_x', effect: this.probeEffect } };
  }
  async getMessages() { return { data: [], cursor: { next: null } }; }
}

/** Executor whose readiness check is stubbed as ready (for lifecycle tests). */
function makeExecutor(store, api, overrides = {}) {
  const config = { ...CONFIG, ...(overrides.config || {}) };
  return new Executor({
    api,
    store,
    config,
    readyCheck: overrides.readyCheck ?? (async () => ({ ok: true, reason: 'test', mode: 'full' })),
    now: overrides.now,
  });
}

function newExecutor(store, api) {
  return makeExecutor(store, api);
}

// ---------------------------------------------------------------------------
// 1. verifyExecutorReady
// ---------------------------------------------------------------------------

test('readiness: missing agent is not ready', async () => {
  const api = new FakeApi();
  api.agent = null;
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, false);
});

test('readiness: full (non-deny-all) agent IS ready with mode full', async () => {
  const api = new FakeApi(); // default agent is a full worker (no deny-all)
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'full', 'a non-deny-all ruleset is the full-tools mode');
});

test('readiness: deny-all agent is ready but reported as restricted', async () => {
  const api = new FakeApi();
  api.agent.permissions = [
    { action: '*', resource: '*', effect: 'allow' },
    { action: '*', resource: '*', effect: 'deny' },
  ];
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true, 'a deny-all agent exists and is still accepted');
  assert.equal(res.mode, 'restricted');
});

test('readiness: subagent-only agent is not ready', async () => {
  const api = new FakeApi();
  api.agent.mode = 'subagent';
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, false);
});

test('readiness: default verifier is live (no positive cache)', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  // Default readyCheck (no injection) -> delegates to verifyExecutorReady.
  const ex = new Executor({ api, store, config: CONFIG });

  await ex.verifyReady();
  await ex.verifyReady();
  assert.equal(api.calls.getAgent, 2, 'verifier must perform a live check each time');

  rmSync(dir, { recursive: true, force: true });
});

test('readiness: submitTask proceeds when the executor agent is available', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  const ex = new Executor({ api, store, config: CONFIG }); // real verifier -> ok:true (full)

  const res = await ex.submitTask('hello');
  assert.equal(res.status, 'submitted');
  assert.equal(api.calls.createSession, 1, 'a session is created for a ready executor');
  assert.deepEqual(api.lastCreateSession, { directory: CONFIG.workdir },
    'the task session must be created in the configured absolute workdir');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1a. Cold-boot retry of the executor-agent lookup (verifyExecutorReady)
// ---------------------------------------------------------------------------

function agentNotFound404() {
  return new OpenCodeError('opencode api exited 1: HTTP 404 Not Found', 'exit', { httpStatus: 404 });
}

test('readiness retry: one 404 then a valid agent passes (2 lookups)', async () => {
  const api = new FakeApi();
  api.getAgentQueue = [agentNotFound404(), api.agent];
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(api.calls.getAgent, 2, 'one retry after the 404');
});

test('readiness retry: two 404s then a valid agent passes (3 lookups)', async () => {
  const api = new FakeApi();
  api.getAgentQueue = [agentNotFound404(), agentNotFound404(), api.agent];
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(api.calls.getAgent, 3, 'bounded to three attempts total');
});

test('readiness retry: persistent 404 gives up after three attempts', async () => {
  const api = new FakeApi();
  api.agentError = agentNotFound404(); // every call throws 404
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(api.calls.getAgent, 3, 'exactly three attempts, then refuse');
});

test('readiness retry: a non-404 failure fails immediately without retry', async () => {
  // Bare non-zero exit with no HTTP status must NOT be retried.
  const api1 = new FakeApi();
  api1.agentError = new OpenCodeError('opencode api exited 1', 'exit');
  let res = await verifyExecutorReady(api1, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(api1.calls.getAgent, 1, 'bare exit is not a retry signal');

  // Timeout must NOT be retried.
  const api2 = new FakeApi();
  api2.agentError = new OpenCodeError('timed out', 'timeout');
  res = await verifyExecutorReady(api2, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(api2.calls.getAgent, 1);

  // HTTP 500 must NOT be retried (only 404 is).
  const api3 = new FakeApi();
  api3.agentError = new OpenCodeError('exited 1: HTTP 500', 'exit', { httpStatus: 500 });
  res = await verifyExecutorReady(api3, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(api3.calls.getAgent, 1);
});

test('readiness retry: a 404 then a wrong-id agent is refused', async () => {
  const api = new FakeApi();
  api.getAgentQueue = [agentNotFound404(), { id: 'other', mode: 'primary', permissions: api.agent.permissions }];
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(api.calls.getAgent, 2, 'validation runs once after the successful lookup');
});

test('readiness retry: a 404 then a full agent passes', async () => {
  const api = new FakeApi();
  api.getAgentQueue = [
    agentNotFound404(),
    { id: 'executor', mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
  ];
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'full');
  assert.equal(api.calls.getAgent, 2, 'no further lookups after the successful lookup');
});

test('readiness retry: refusal before readiness never creates a session or sends a prompt', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.agentError = agentNotFound404(); // persistent 404
  const ex = new Executor({ api, store, config: CONFIG }); // real verifier

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e instanceof BridgeError && e.code === 'EXECUTOR_UNAVAILABLE',
  );
  assert.equal(api.calls.getAgent, 3, 'bounded retries then refuse');
  assert.equal(api.calls.createSession, 0, 'no session created');
  assert.equal(api.calls.sendPrompt, 0, 'no prompt sent');
  assert.equal(ex.activeTaskId, null, 'slot released');

  rmSync(dir, { recursive: true, force: true });
});

test('readiness retry: a successful first lookup makes no extra calls', async () => {
  const api = new FakeApi(); // default getAgent returns a valid agent immediately
  const res = await verifyExecutorReady(api, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(api.calls.getAgent, 1, 'exactly one lookup');
});

test('readiness retry: production retry schedule is [0, 500, 1000], cap is 3', () => {
  assert.deepEqual(AGENT_LOOKUP_RETRY_DELAYS_MS, [0, 500, 1000]);
  assert.equal(AGENT_LOOKUP_MAX_ATTEMPTS, 3);
});

test('readiness retry: attempt count is capped at 3 even with a longer delay list', async () => {
  const api = new FakeApi();
  api.agentError = agentNotFound404();
  const res = await verifyExecutorReady(api, {
    ...CONFIG,
    agentLookupRetryDelaysMs: [0, 0, 0, 0, 0], // longer than the cap
  });
  assert.equal(res.ok, false);
  assert.equal(api.calls.getAgent, 3, 'attempt count must not exceed the cap');
});

test('parseHttpStatus: reads only the CLI status line, never an arbitrary number', () => {
  assert.equal(parseHttpStatus('HTTP 404 Not Found'), 404);
  assert.equal(parseHttpStatus('HTTP 404 Not Found\n'), 404, 'trailing newline is allowed');
  assert.equal(parseHttpStatus('HTTP 500 Internal Server Error'), 500);
  assert.equal(parseHttpStatus('some diagnostic: HTTP 404 Not Found'), null, 'embedded status in a diagnostic line');
  assert.equal(parseHttpStatus('opencode api exited 1: agent 404 not found'), null);
  assert.equal(parseHttpStatus('HTTP 4040 bogus'), null, 'no partial-digit match');
  assert.equal(parseHttpStatus(''), null);
  assert.equal(parseHttpStatus(null), null);
});

// ---------------------------------------------------------------------------
// 1b. Admission: session state confirmation (no permission probes anymore)
// ---------------------------------------------------------------------------

test('admission: no permission probes run; the prompt is sent after readiness', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  const ex = newExecutor(store, api);

  const res = await ex.submitTask('hello');
  assert.equal(res.status, 'submitted');
  assert.equal(api.calls.sendPrompt, 1, 'exactly one prompt sent');
  assert.equal(api.calls.evaluatePermission, 0, 'the deny-all permission probes are gone');
  assert.equal(ex.activeTaskId, res.taskID, 'slot held for the running task');

  rmSync(dir, { recursive: true, force: true });
});

test('admission: session agent mismatch blocks the prompt', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sessionAgent = 'build';
  const ex = newExecutor(store, api);

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e instanceof BridgeError && e.code === 'AGENT_MISMATCH',
  );
  assert.equal(api.calls.sendPrompt, 0);
  assert.equal(ex.activeTaskId, null);
  assert.equal(store.getBySessionId('ses_1').status, 'error');

  rmSync(dir, { recursive: true, force: true });
});

test('admission: session model mismatch blocks the prompt', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sessionModel = { id: 'other-model', providerID: 'apmix' };
  const ex = newExecutor(store, api);

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e instanceof BridgeError && e.code === 'MODEL_MISMATCH',
  );
  assert.equal(api.calls.sendPrompt, 0);
  assert.equal(ex.activeTaskId, null);
  assert.equal(store.getBySessionId('ses_1').status, 'error');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. Concurrent submitTask (atomic slot reservation)
// ---------------------------------------------------------------------------

test('concurrency: overlapping submits reserve a single slot (one TASK_BUSY)', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  const ex = newExecutor(store, api);

  // Both called synchronously before either resolves: the slot is reserved
  // synchronously inside submitTask, so only one can proceed.
  const p1 = ex.submitTask('first');
  const p2 = ex.submitTask('second');

  await assert.rejects(p2, (e) => e.code === 'TASK_BUSY');
  const r1 = await p1;
  assert.equal(r1.status, 'submitted');
  assert.equal(api.calls.createSession, 1, 'only one session may be created');
  assert.equal(api.calls.sendPrompt, 1);

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Ambiguous sendPrompt (returns taskID + unknown, keeps slot, no retry)
// ---------------------------------------------------------------------------

test('ambiguous prompt: returns taskID/unknown, holds slot, no retry', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sendPromptError = new OpenCodeError('timed out', 'timeout');
  const ex = newExecutor(store, api);

  const res = await ex.submitTask('hello'); // must NOT throw
  assert.equal(res.status, 'unknown');
  assert.match(res.taskID, /^task_/);
  assert.equal(api.calls.sendPrompt, 1, 'prompt must not be retried');
  assert.equal(ex.activeTaskId, res.taskID, 'slot must remain held');

  const task = store.get(res.taskID);
  assert.equal(task.status, 'unknown');

  // Watchdog resolves it once OpenCode reports a terminal outcome.
  api.sessionOutcome = 'succeeded';
  await ex.watchdogTick();
  assert.equal(ex.activeTaskId, null, 'slot released after terminal outcome');
  assert.equal(store.get(res.taskID).status, 'completed');

  rmSync(dir, { recursive: true, force: true });
});

test('ambiguous prompt: HTTP 500 on send keeps slot (exit code is not proof)', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sendPromptError = new OpenCodeError('exited 500: server error', 'exit', { httpStatus: 500 });
  const ex = newExecutor(store, api);

  const res = await ex.submitTask('hello'); // must NOT throw
  assert.equal(res.status, 'unknown');
  assert.equal(ex.activeTaskId, res.taskID, 'slot must remain held on HTTP 500');
  assert.equal(api.calls.sendPrompt, 1, 'prompt must not be retried');
  assert.equal(store.get(res.taskID).status, 'unknown');

  rmSync(dir, { recursive: true, force: true });
});

test('definite prompt rejection: releases slot, error code, no retry', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sendPromptError = new OpenCodeError('exited 400: bad request', 'exit', { httpStatus: 400 });
  const ex = newExecutor(store, api);

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e.code === 'PROMPT_REJECTED',
  );
  assert.equal(api.calls.sendPrompt, 1);
  assert.equal(ex.activeTaskId, null, 'slot released on confirmed rejection');
  const task = store.getBySessionId('ses_1');
  assert.equal(task.status, 'error');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('classification: timeout/non-json are ambiguous; spawn is definite; bare exit is ambiguous', () => {
  assert.equal(classifyError(new OpenCodeError('x', 'timeout')), 'ambiguous');
  assert.equal(classifyError(new OpenCodeError('x', 'non-json')), 'ambiguous');
  // A non-zero exit code alone is NOT proof of rejection: no status/tag -> ambiguous.
  assert.equal(classifyError(new OpenCodeError('x', 'exit')), 'ambiguous');
  assert.equal(classifyError(new OpenCodeError('x', 'spawn')), 'definite');
  // Unknown error type defaults to ambiguous (never treated as a rejection).
  assert.equal(classifyError(new Error('plain')), 'ambiguous');
  assert.equal(isAmbiguousError(new OpenCodeError('x', 'non-json')), true);
  assert.equal(isDefiniteRejection(new OpenCodeError('x', 'spawn')), true);
  assert.equal(isDefiniteRejection(new OpenCodeError('x', 'exit')), false);
});

test('classification: explicit 4xx rejection statuses are definite', () => {
  for (const s of [400, 401, 403, 404]) {
    assert.equal(
      classifyError(new OpenCodeError('x', 'exit', { httpStatus: s })),
      'definite',
      `HTTP ${s} must be definite`,
    );
  }
});

test('classification: 429, 5xx and other statuses stay ambiguous', () => {
  for (const s of [429, 500, 502, 503, 504, 409, 408, 405, 422]) {
    assert.equal(
      classifyError(new OpenCodeError('x', 'exit', { httpStatus: s })),
      'ambiguous',
      `HTTP ${s} must be ambiguous`,
    );
  }
});

test('classification: rejection tag is definite only when status is unparsed', () => {
  assert.equal(
    classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'InvalidRequestError' })),
    'definite',
  );
  assert.equal(
    classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'SessionNotFoundError' })),
    'definite',
  );
  assert.equal(
    classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'InternalError' })),
    'ambiguous',
  );
  assert.equal(
    classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: null })),
    'ambiguous',
  );
});

test('parseModelRef: converts providerID/model string to Model.Ref object', () => {
  assert.deepEqual(parseModelRef('opencode/longcat-2.5-free'), {
    providerID: 'opencode',
    id: 'longcat-2.5-free',
  });
  assert.deepEqual(parseModelRef('anthropic/claude-sonnet#high'), {
    providerID: 'anthropic',
    id: 'claude-sonnet',
    variant: 'high',
  });
  // Already-shaped object passes through (with variant preserved).
  assert.deepEqual(parseModelRef({ providerID: 'apmix', id: 'mimo-v2.6-pro' }), {
    providerID: 'apmix',
    id: 'mimo-v2.6-pro',
  });
  // Invalid inputs -> null (so setModel rejects as a definite 400).
  assert.equal(parseModelRef(''), null);
  assert.equal(parseModelRef('no-slash'), null);
  assert.equal(parseModelRef('opencode/'), null);
  assert.equal(parseModelRef('/model'), null);
  assert.equal(parseModelRef(null), null);
  assert.equal(parseModelRef({ id: 'x' }), null);
});

// ---------------------------------------------------------------------------
// 3b. Mandatory executor model (no null / no OpenCode inheritance)
// ---------------------------------------------------------------------------

test('model: missing/empty/invalid executor model refuses with BAD_CONFIG before any call', async () => {
  for (const bad of [undefined, null, '', '   ', 'no-slash', '/model', 'provider/', 'apmix/x#']) {
    const { dir, store } = freshStore();
    const api = new FakeApi();
    let readyCalls = 0;
    const ex = makeExecutor(store, api, {
      config: { executorModel: bad },
      readyCheck: async () => { readyCalls++; return { ok: true, reason: null, mode: 'full' }; },
    });

    await assert.rejects(
      () => ex.submitTask('hello'),
      (e) => e instanceof BridgeError && e.code === 'BAD_CONFIG',
      `model ${JSON.stringify(bad)} must be refused`,
    );
    assert.equal(readyCalls, 0, 'readiness check must not run');
    assert.equal(api.calls.createSession, 0);
    assert.equal(api.calls.setAgent, 0);
    assert.equal(api.calls.setModel, 0);
    assert.equal(api.calls.getStatus, 0);
    assert.equal(api.calls.sendPrompt, 0);
    assert.equal(ex.activeTaskId, null, 'slot must never be reserved');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model: a valid configured model is applied and confirmed before the prompt', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sessionModel = { id: 'deepseek-v4.1-flash-1017', providerID: 'apmix' };
  const ex = makeExecutor(store, api, { config: { executorModel: ' apmix/deepseek-v4.1-flash-1017 ' } });

  const res = await ex.submitTask('hello');
  assert.equal(res.status, 'submitted');
  assert.equal(api.calls.setModel, 1);
  assert.equal(api.calls.sendPrompt, 1);
  assert.equal(ex.activeTaskId, res.taskID);
  rmSync(dir, { recursive: true, force: true });
});

test('model: explicitly configured variant mismatch blocks the prompt', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sessionModel = { id: 'deepseek-v4.1-flash-1017', providerID: 'apmix', variant: 'low' };
  const ex = makeExecutor(store, api, { config: { executorModel: 'apmix/deepseek-v4.1-flash-1017#high' } });

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e instanceof BridgeError && e.code === 'MODEL_MISMATCH',
  );
  assert.equal(api.calls.sendPrompt, 0, 'prompt must not be sent');
  assert.equal(ex.activeTaskId, null, 'nothing ran -> slot released');
  rmSync(dir, { recursive: true, force: true });
});

test('model: a missing variant when one is configured is also a mismatch', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.sessionModel = { id: 'deepseek-v4.1-flash-1017', providerID: 'apmix' };
  const ex = makeExecutor(store, api, { config: { executorModel: 'apmix/deepseek-v4.1-flash-1017#high' } });

  await assert.rejects(
    () => ex.submitTask('hello'),
    (e) => e instanceof BridgeError && e.code === 'MODEL_MISMATCH',
  );
  assert.equal(api.calls.sendPrompt, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. Cancel semantics
// ---------------------------------------------------------------------------

test('cancel: confirmed interrupt releases slot and marks cancelled', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interrupted = true;
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  const res = await ex.cancelTask(taskID);
  assert.equal(res.cancelled, true);
  assert.equal(ex.activeTaskId, null);
  assert.equal(store.get(taskID).status, 'cancelled');
  assert.equal(store.get(taskID).outcome, 'interrupted');

  rmSync(dir, { recursive: true, force: true });
});

test('cancel: interrupted=false does NOT release slot or mark cancelled', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interrupted = false;
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  const res = await ex.cancelTask(taskID);
  assert.equal(res.cancelled, false);
  assert.equal(ex.activeTaskId, taskID, 'slot must remain held');
  assert.notEqual(store.get(taskID).status, 'cancelled', 'must not synthesize cancellation');

  rmSync(dir, { recursive: true, force: true });
});

test('cancel: interrupt API error does NOT release slot', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interruptError = new OpenCodeError('timed out', 'timeout');
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  const res = await ex.cancelTask(taskID);
  assert.equal(res.cancelled, false);
  assert.equal(res.status, 'unknown');
  assert.equal(ex.activeTaskId, taskID, 'slot must remain held on ambiguous cancel');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Watchdog / recover interrupt semantics
// ---------------------------------------------------------------------------

test('watchdog: unconfirmed interrupt keeps task tracked and slot held', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interrupted = false;
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  ex.activeTaskStartedAt = ex.now() - (CONFIG.taskExecutionTimeoutMs + 1000);
  await ex.watchdogTick();

  assert.equal(ex.activeTaskId, taskID, 'slot must remain held when interrupt not confirmed');
  assert.notEqual(store.get(taskID).status, 'cancelled');

  rmSync(dir, { recursive: true, force: true });
});

test('watchdog: confirmed interrupt on timeout releases slot', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interrupted = true;
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  ex.activeTaskStartedAt = ex.now() - (CONFIG.taskExecutionTimeoutMs + 1000);
  await ex.watchdogTick();

  assert.equal(ex.activeTaskId, null);
  assert.equal(store.get(taskID).status, 'cancelled');

  rmSync(dir, { recursive: true, force: true });
});

test('recover: unconfirmed interrupt keeps task tracked, blocks next submit', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.interrupted = false;
  const ex = newExecutor(store, api);

  const { taskID } = await ex.submitTask('hello');
  ex.activeTaskId = null; // simulate process restart
  ex.activeTaskStartedAt = null;

  await ex.recover();
  // The task is not terminal and not interruptable -> still tracked, slot held.
  assert.equal(ex.activeTaskId, taskID, 'slot must be re-acquired by the unresolved task');
  assert.notEqual(store.get(taskID).status, 'cancelled');

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. Result size budget + error codes + argument validation
// ---------------------------------------------------------------------------

test('result: combined result + toolCalls respects the size budget', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  api.getMessages = async () => ({
    data: [
      { type: 'assistant', content: [
        { type: 'text', text: 'y'.repeat(1000) },
        { type: 'reasoning', text: 'SECRET reasoning' },
        { type: 'tool', name: 'read', state: { status: 'completed' } },
        { type: 'tool', name: 'read2', state: { status: 'completed' } },
      ] },
    ],
    cursor: { next: null },
  });
  api.sessionOutcome = 'succeeded';
  const ex = makeExecutor(store, api, { config: { maxResultLength: 120 } });

  const { taskID } = await ex.submitTask('hello');
  const res = await ex.getResult(taskID);

  const total = res.result.length + JSON.stringify(res.toolCalls).length;
  assert.ok(total <= 120, `total ${total} must be <= 120`);
  assert.equal(res.truncated, true);
  assert.ok(!res.result.includes('reasoning'), 'reasoning blocks excluded');

  rmSync(dir, { recursive: true, force: true });
});

test('budget helper: drops toolCalls when they alone exceed the limit', () => {
  const res = enforceResultBudget('short', [{ name: 'x'.repeat(500) }], 120);
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.truncated, true);
});

test('executor: unknown taskID yields NOT_FOUND (no foreign session access)', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  const ex = newExecutor(store, api);

  await assert.rejects(() => ex.getStatus('task_nope'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => ex.getResult('task_nope'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => ex.cancelTask('task_nope'), (e) => e.code === 'NOT_FOUND');

  rmSync(dir, { recursive: true, force: true });
});

test('executor: invalid prompt is rejected with INVALID_ARGUMENT / PROMPT_TOO_LONG', async () => {
  const { dir, store } = freshStore();
  const api = new FakeApi();
  const ex = newExecutor(store, api);

  await assert.rejects(() => ex.submitTask('   '), (e) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(
    () => ex.submitTask('x'.repeat(CONFIG.maxPromptLength + 1)),
    (e) => e.code === 'PROMPT_TOO_LONG',
  );

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth + outcome mapping
// ---------------------------------------------------------------------------

test('auth: Bearer verifier accepts correct token, rejects missing/wrong', () => {
  const auth = new BearerAuth('secret-token-123');
  assert.equal(auth.verify({ headers: { authorization: 'Bearer secret-token-123' } }), true);
  assert.equal(auth.verify({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(auth.verify({ headers: {} }), false);
  assert.equal(auth.verify({ headers: { authorization: 'Basic abc' } }), false);
});

test('mapOutcomeToStatus covers all documented outcomes', () => {
  assert.equal(mapOutcomeToStatus(null), 'pending_or_running');
  assert.equal(mapOutcomeToStatus('succeeded'), 'completed');
  assert.equal(mapOutcomeToStatus('failed'), 'failed');
  assert.equal(mapOutcomeToStatus('interrupted'), 'cancelled');
});

test('classifyResultStatus distinguishes completed / partial / failed / cancelled / pending', () => {
  // Clean success -> completed.
  assert.equal(classifyResultStatus('succeeded', [], false), 'completed');
  assert.equal(
    classifyResultStatus('succeeded', [{ name: 'read', status: 'completed' }], false),
    'completed',
  );

  // Truncation downgrades a success to partial (result not fully delivered).
  assert.equal(classifyResultStatus('succeeded', [], true), 'partial');

  // A tool that errored downgrades a success to partial (goal not fully clean).
  assert.equal(
    classifyResultStatus('succeeded', [{ name: 'read', status: 'error' }], false),
    'partial',
  );

  // Failure and interruption are passed through verbatim.
  assert.equal(classifyResultStatus('failed', [], false), 'failed');
  assert.equal(classifyResultStatus('interrupted', [], false), 'cancelled');

  // No outcome yet -> still running.
  assert.equal(classifyResultStatus(null, [], false), 'pending_or_running');

  // null toolCalls never throw.
  assert.equal(classifyResultStatus('succeeded', null, false), 'completed');
});
