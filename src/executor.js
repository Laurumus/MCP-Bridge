import { randomUUID } from 'node:crypto';
import { TERMINAL_STATUSES } from './store.js';
import { isAmbiguousError, parseModelRef, modelRefMatches } from './opencode-api.js';

const TRUNCATED_MARKER = '[TRUNCATED]';

export class BridgeError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'BridgeError';
    this.code = code; // safe, client-facing identifier (never the raw message)
    if (cause !== undefined) this.cause = cause; // detail for the local log only
  }
}

/** outcome (Session.Info.outcome) -> bridge status string. */
export function mapOutcomeToStatus(outcome) {
  if (outcome == null) return 'pending_or_running';
  if (outcome === 'succeeded') return 'completed';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'interrupted') return 'cancelled';
  return 'pending_or_running';
}

/**
 * Client-facing classification of a finished task, distinguishing the four
 * honest outcomes the bridge reports: completed, partial, failed, blocked
 * (plus cancelled / pending). `partial` means OpenCode reported success but the
 * delivered result is incomplete (budget-truncated) or a tool call errored —
 * the goal is NOT treated as fully achieved in that case.
 */
export function classifyResultStatus(outcome, toolCalls, truncated) {
  if (outcome === 'interrupted') return 'cancelled';
  if (outcome === 'failed') return 'failed';
  if (outcome == null) return 'pending_or_running';
  if (truncated) return 'partial';
  if (Array.isArray(toolCalls) && toolCalls.some((c) => c?.status === 'error')) return 'partial';
  return 'completed';
}

/**
 * Cap the combined size of a task result's text and toolCalls so the total
 * payload returned to the MCP client never exceeds `maxLen` characters.
 */
export function enforceResultBudget(result, toolCalls, maxLen) {
  const marker = TRUNCATED_MARKER;
  let truncated = false;
  let toolCallsJson = JSON.stringify(toolCalls);

  // If toolCalls alone exhaust the budget, drop them entirely.
  if (toolCallsJson.length + marker.length >= maxLen) {
    toolCalls = [];
    toolCallsJson = '[]';
    truncated = true;
  }

  const budget = Math.max(0, maxLen - marker.length - toolCallsJson.length);
  if (result.length > budget) {
    result = result.slice(0, budget) + marker;
    truncated = true;
  }

  return { result, toolCalls, truncated };
}

/**
 * True when the permission ruleset ends in a universal deny-all: there is a
 * `{action:"*", resource:"*", effect:"deny"}` rule after which no `allow` or
 * `ask` rule appears. Only `deny` rules may follow the deny-all. With
 * last-match-wins semantics this makes every (action, resource) resolve to
 * `deny`. Any `allow`/`ask` after the deny-all invalidates isolation.
 */
export function denyAllIsFinal(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) return false;
  let seenDenyAll = false;
  for (const rule of permissions) {
    if (seenDenyAll) {
      if (rule?.effect !== 'deny') return false;
    } else if (rule?.action === '*' && rule?.resource === '*' && rule?.effect === 'deny') {
      seenDenyAll = true;
    }
  }
  return seenDenyAll;
}

/**
 * Hard cap on agent-lookup attempts. The number of attempts is fixed and never
 * derived from the (test-overridable) delay list, so shortening the delays for
 * tests can never increase the attempt count. Only a reliably established
 * HTTP 404 (the cold-boot race) is ever retried.
 */
export const AGENT_LOOKUP_MAX_ATTEMPTS = 3;

/**
 * Default delay before each lookup attempt: 0ms (first, immediate), 500ms,
 * then 1000ms. Tests may override this (via `config.agentLookupRetryDelaysMs`)
 * to shorten the pauses; the attempt count stays capped at
 * AGENT_LOOKUP_MAX_ATTEMPTS.
 */
export const AGENT_LOOKUP_RETRY_DELAYS_MS = [0, 500, 1000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True only when `e` is a reliably-established HTTP 404 from the API wrapper. */
function isAgentNotFound404(e) {
  return e?.kind === 'exit' && e?.httpStatus === 404;
}

/**
 * Readiness check (no session): the executor agent must exist, be
 * primary-capable, and be selected by its ID. This is a live check — a positive
 * result is never cached. It does NOT require a deny-all: the executor is
 * allowed the normal worker tools of the default coding agent.
 *
 * Returns `{ ok, reason, mode }` where `mode` is 'full' (tools enabled) or
 * 'restricted' (the agent's ruleset still ends in a universal deny-all), so the
 * caller can log the actual mode of operation truthfully.
 *
 * The agent lookup retries only a reliably-established HTTP 404 (up to a fixed
 * cap of AGENT_LOOKUP_MAX_ATTEMPTS attempts) because `opencode serve` can
 * report 404 while a freshly evicted location is still loading its agent
 * registry. A bare non-zero exit is never retried, and a persistent 404 still
 * fails the check.
 */
export async function verifyExecutorReady(api, config) {
  const delays = Array.isArray(config.agentLookupRetryDelaysMs)
    ? config.agentLookupRetryDelaysMs
    : AGENT_LOOKUP_RETRY_DELAYS_MS;

  let agent = null;
  let lookupError = null;

  for (let attempt = 0; attempt < AGENT_LOOKUP_MAX_ATTEMPTS; attempt++) {
    await sleep(delays[attempt] ?? 0); // delays[0] is 0: first attempt is immediate
    try {
      const resp = await api.getAgent(config.executorAgent, config.opencodeApiTimeoutMs);
      agent = resp?.data ?? null;
      lookupError = null;
      break;
    } catch (e) {
      lookupError = e;
      // Retry ONLY a reliably-established HTTP 404 (the cold-boot race). A
      // bare non-zero exit, a timeout, or any other status fails immediately.
      if (!isAgentNotFound404(e)) break;
    }
  }

  if (lookupError) {
    return {
      ok: false,
      reason: `executor agent lookup failed (${lookupError?.kind ?? 'unknown'})`,
    };
  }

  if (!agent || agent.id !== config.executorAgent) {
    return {
      ok: false,
      reason: `executor agent "${config.executorAgent}" is not available in OpenCode`,
    };
  }

  if (agent.mode === 'subagent') {
    return {
      ok: false,
      reason: `executor agent "${config.executorAgent}" is subagent-only (must be primary-capable)`,
    };
  }

  const mode = denyAllIsFinal(agent.permissions) ? 'restricted' : 'full';
  return { ok: true, reason: null, mode };
}

/**
 * Lifecycle manager for bridge tasks.
 *
 * Invariants:
 * - one task = one new session + one prompt;
 * - the active slot is reserved atomically (synchronously) BEFORE the first
 *   await, so only one submitTask can create a session;
 * - a task row is persisted BEFORE the prompt is sent;
 * - the executor agent/model/workdir come from local config, never the client;
 * - readiness (agent exists and is primary-capable) is verified before any
 *   real submission; if not ready the submission is refused;
 * - the slot is released ONLY on a proven safe outcome (a terminal status, or
 *   a definite failure before anything could run). Ambiguous outcomes keep the
 *   task tracked, keep the slot held, and block the next task;
 * - the prompt is never retried after an ambiguous send.
 */
export class Executor {
  constructor({ api, store, config, now = () => Date.now(), readyCheck }) {
    this.api = api;
    this.store = store;
    this.config = config;
    this.now = now;
    this.activeTaskId = null;
    this.activeTaskStartedAt = null;
    // The verifier is injectable so lifecycle tests can pass a stub that
    // returns ok:true. Production always uses the safe default above.
    this._readyCheck = readyCheck ?? (() => verifyExecutorReady(this.api, this.config));
  }

  verifyReady() {
    return this._readyCheck();
  }

  _releaseSlot(taskId) {
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
      this.activeTaskStartedAt = null;
    }
  }

  /** Create a new session, verify readiness, and submit exactly one prompt. */
  async submitTask(prompt) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new BridgeError('prompt is required', 'INVALID_ARGUMENT');
    }
    if (prompt.length > this.config.maxPromptLength) {
      throw new BridgeError(
        `prompt too long (max ${this.config.maxPromptLength} characters)`,
        'PROMPT_TOO_LONG',
      );
    }

    // 0. Defensive configuration check BEFORE the slot is reserved: a missing,
    // empty or malformed model must never reach readiness, the API or a
    // session. Startup already validates this; the check also covers a
    // config object mutated after construction. No fallback to an
    // OpenCode-inherited model.
    const expectedModel = parseModelRef(this.config.executorModel);
    if (!expectedModel) {
      throw new BridgeError(
        'invalid executor model configuration (BRIDGE_EXECUTOR_MODEL is required)',
        'BAD_CONFIG',
      );
    }

    // 1. Atomic slot reservation BEFORE any await. Two overlapping submitTask
    // calls race synchronously here and exactly one wins. The configured model
    // is checked even earlier (step 0) so a bad configuration never reserves it.
    if (this.activeTaskId) {
      throw new BridgeError('another task is already active', 'TASK_BUSY');
    }
    const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const createdAt = this.now();
    this.activeTaskId = taskId;
    this.activeTaskStartedAt = createdAt;

    // 2. Readiness check: executor agent exists and is primary-capable.
    let readiness;
    try {
      readiness = await this.verifyReady();
    } catch (e) {
      this._releaseSlot(taskId);
      throw new BridgeError('executor readiness check failed', 'EXECUTOR_CHECK_FAILED', e);
    }
    if (!readiness.ok) {
      this._releaseSlot(taskId);
      throw new BridgeError(
        `executor unavailable: ${readiness.reason}`,
        'EXECUTOR_UNAVAILABLE',
      );
    }

    // 3. Create the task's own session.
    let sessionId;
    try {
      const resp = await this.api.createSession(
        { directory: this.config.workdir },
        this.config.opencodeApiTimeoutMs,
      );
      sessionId = resp?.data?.id ?? null;
    } catch (e) {
      this._releaseSlot(taskId);
      if (isAmbiguousError(e)) {
        throw new BridgeError('session creation outcome unknown', 'SESSION_CREATE_AMBIGUOUS', e);
      }
      throw new BridgeError('failed to create session', 'SESSION_CREATE_FAILED', e);
    }
    if (!sessionId) {
      this._releaseSlot(taskId);
      throw new BridgeError('create session returned no id', 'BAD_RESPONSE');
    }

    // 4. Persist the taskID/sessionID binding BEFORE the prompt, so the session
    // is never silently lost.
    this.store.insert({
      taskId, sessionId, prompt, createdAt,
      status: 'submitting', outcome: null, error: null,
    });

    // 5. Explicitly select the executor agent and the configured model.
    try {
      await this.api.setAgent(sessionId, this.config.executorAgent, this.config.opencodeApiTimeoutMs);
      await this.api.setModel(sessionId, this.config.executorModel, this.config.opencodeApiTimeoutMs);
    } catch (e) {
      this.store.update(taskId, { status: 'error', outcome: null, error: 'session setup failed' });
      this._releaseSlot(taskId);
      throw new BridgeError('failed to configure executor session', 'SETUP_FAILED', e);
    }

    // 6. Confirm the session actually runs the executor agent and configured model.
    const confirm = await this._confirmSessionState(taskId, sessionId);
    if (!confirm.ok) {
      // Reason persisted inside; the prompt was definitely not sent -> release.
      this._releaseSlot(taskId);
      throw new BridgeError(confirm.reason, confirm.code);
    }

    // 7. Send the prompt exactly once — never retried.
    let sendErr = null;
    try {
      await this.api.sendPrompt(sessionId, prompt, this.config.opencodeApiTimeoutMs);
    } catch (e) {
      sendErr = e;
    }

    if (sendErr) {
      if (isAmbiguousError(sendErr)) {
        // Ambiguous: keep the task tracked and holding the slot; return the
        // taskID and an honest "unknown" status rather than an exception.
        this.store.update(taskId, {
          status: 'unknown', outcome: null, error: 'prompt send outcome unknown (not retried)',
        });
        return { taskID: taskId, status: 'unknown' };
      }
      // Confirmed rejection: nothing is running, so the slot is safe to release.
      this.store.update(taskId, { status: 'error', outcome: null, error: 'prompt rejected by OpenCode' });
      this._releaseSlot(taskId);
      throw new BridgeError('prompt rejected by OpenCode', 'PROMPT_REJECTED', sendErr);
    }

    this.store.update(taskId, { status: 'pending', outcome: null, error: null });
    return { taskID: taskId, status: 'submitted' };
  }

  /**
   * Read the task's session and confirm the executor agent and configured
   * model are actually in effect. On any mismatch the safe refusal reason is
   * persisted to the task and { ok:false } is returned (it never throws for a
   * mismatch). The prompt is not sent by the caller in that case.
   */
  async _confirmSessionState(taskId, sessionId) {
    let data;
    try {
      const resp = await this.api.getStatus(sessionId, this.config.opencodeApiTimeoutMs);
      data = resp?.data ?? {};
    } catch {
      this.store.update(taskId, { status: 'error', outcome: null, error: 'session state read failed' });
      return { ok: false, reason: 'session state unavailable', code: 'STATUS_UNAVAILABLE' };
    }

    if (data.agent !== this.config.executorAgent) {
      this.store.update(taskId, { status: 'error', outcome: null, error: 'session agent mismatch' });
      return { ok: false, reason: 'session agent mismatch', code: 'AGENT_MISMATCH' };
    }

    const expected = parseModelRef(this.config.executorModel);
    if (!expected) {
      this.store.update(taskId, { status: 'error', outcome: null, error: 'invalid executor model ref' });
      return { ok: false, reason: 'invalid executor model configuration', code: 'BAD_CONFIG' };
    }
    // modelRefMatches also compares an explicitly configured `#variant`; any
    // mismatch (including a missing variant or a different one) refuses here,
    // so the prompt is never sent to a session running another model/variant.
    const model = data.model ?? null;
    if (!modelRefMatches(expected, model)) {
      this.store.update(taskId, { status: 'error', outcome: null, error: 'session model mismatch' });
      return { ok: false, reason: 'session model mismatch', code: 'MODEL_MISMATCH' };
    }

    return { ok: true, reason: null, code: null };
  }

  async getStatus(taskId) {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError(`task ${taskId} not found`, 'NOT_FOUND');

    if (TERMINAL_STATUSES.includes(task.status) || task.status === 'error') {
      return {
        taskID: taskId,
        status: task.status,
        outcome: task.outcome,
        error: task.error,
        cost: null,
        tokens: null,
      };
    }

    let data;
    try {
      const resp = await this.api.getStatus(task.sessionId, this.config.opencodeApiTimeoutMs);
      data = resp?.data ?? {};
    } catch (e) {
      throw new BridgeError('status unavailable', 'STATUS_UNAVAILABLE', e);
    }

    const outcome = data.outcome ?? null;
    const status = mapOutcomeToStatus(outcome);
    this.store.update(taskId, { status, outcome, error: null });
    if (TERMINAL_STATUSES.includes(status)) this._releaseSlot(taskId);

    return {
      taskID: taskId,
      status,
      outcome,
      error: null,
      cost: data.cost ?? null,
      tokens: data.tokens ?? null,
    };
  }

  async getResult(taskId, cursor) {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError(`task ${taskId} not found`, 'NOT_FOUND');

    // A task that never received a running prompt (setup failure or a confirmed
    // prompt rejection) has no result to read: report it as blocked.
    if (task.status === 'error') {
      return {
        taskID: taskId,
        status: 'blocked',
        outcome: task.outcome,
        error: task.error,
        result: '',
        toolCalls: [],
        hasMore: false,
        cursor: null,
        truncated: false,
        cost: null,
        tokens: null,
      };
    }

    let statusResp;
    let messagesResp;
    try {
      [statusResp, messagesResp] = await Promise.all([
        this.api.getStatus(task.sessionId, this.config.opencodeApiTimeoutMs),
        this.api.getMessages(task.sessionId, cursor, this.config.opencodeApiTimeoutMs),
      ]);
    } catch (e) {
      throw new BridgeError('result unavailable', 'RESULT_UNAVAILABLE', e);
    }

    let result = '';
    const toolCalls = [];
    for (const msg of messagesResp?.data ?? []) {
      if (msg.type !== 'assistant') continue;
      for (const c of msg.content ?? []) {
        if (c.type === 'text') {
          result += c.text ?? '';
        } else if (c.type === 'tool') {
          toolCalls.push({ name: c.name ?? null, status: c.state?.status ?? null });
        }
        // reasoning blocks are intentionally excluded
      }
    }

    const budgeted = enforceResultBudget(result, toolCalls, this.config.maxResultLength);

    const nextCursor = messagesResp?.cursor?.next ?? null;
    const data = statusResp?.data ?? {};
    const outcome = data.outcome ?? null;
    const status = classifyResultStatus(outcome, budgeted.toolCalls, budgeted.truncated);
    if (TERMINAL_STATUSES.includes(mapOutcomeToStatus(outcome))) this._releaseSlot(taskId);

    return {
      taskID: taskId,
      status,
      result: budgeted.result,
      toolCalls: budgeted.toolCalls,
      outcome,
      error: task.error,
      hasMore: nextCursor !== null,
      cursor: nextCursor,
      truncated: budgeted.truncated,
      cost: data.cost ?? null,
      tokens: data.tokens ?? null,
    };
  }

  async cancelTask(taskId) {
    const task = this.store.get(taskId);
    if (!task) throw new BridgeError(`task ${taskId} not found`, 'NOT_FOUND');

    let interrupted = false;
    try {
      const resp = await this.api.interrupt(task.sessionId, this.config.opencodeApiTimeoutMs);
      interrupted = !!(resp && resp.interrupted);
    } catch {
      // Ambiguous: keep tracking, hold the slot, block the next task.
      this.store.update(taskId, { status: 'unknown', outcome: null, error: 'interrupt outcome unknown' });
      return { taskID: taskId, cancelled: false, status: 'unknown' };
    }

    if (interrupted) {
      this.store.update(taskId, { status: 'cancelled', outcome: 'interrupted', error: null });
      this._releaseSlot(taskId);
    } else {
      // Confirmed not interrupted: do NOT synthesize a cancellation, do NOT
      // release the slot; the task keeps being tracked.
      this.store.update(taskId, { status: task.status, outcome: task.outcome, error: 'interrupt not confirmed by OpenCode' });
    }

    return { taskID: taskId, cancelled: interrupted, status: interrupted ? 'cancelled' : task.status };
  }

  /** Interrupt and return whether OpenCode confirmed it. Never throws. */
  async _interruptAndConfirm(task) {
    try {
      const resp = await this.api.interrupt(task.sessionId, this.config.opencodeApiTimeoutMs);
      return !!(resp && resp.interrupted);
    } catch {
      return false;
    }
  }

  /** Reconcile active tasks after a process restart. */
  async recover() {
    for (const task of this.store.listNonTerminal()) {
      let outcome = null;
      try {
        const resp = await this.api.getStatus(task.sessionId, this.config.opencodeApiTimeoutMs);
        outcome = resp?.data?.outcome ?? null;
      } catch {
        outcome = null;
      }

      const status = mapOutcomeToStatus(outcome);
      if (TERMINAL_STATUSES.includes(status)) {
        this.store.update(task.taskId, { status, outcome, error: null });
        continue;
      }

      const elapsed = this.now() - task.createdAt;
      if (elapsed > this.config.taskExecutionTimeoutMs) {
        const interrupted = await this._interruptAndConfirm(task);
        if (interrupted) {
          this.store.update(task.taskId, { status: 'cancelled', outcome: 'interrupted', error: 'timed out during recovery' });
          continue;
        }
        // Interrupt not confirmed: keep tracking and hold the slot.
        this.store.update(task.taskId, { status: 'unknown', outcome: null, error: 'recovery timeout; interrupt not confirmed' });
      }

      // Take the slot for the first unresolved task (block the next submission).
      if (!this.activeTaskId) {
        this.activeTaskId = task.taskId;
        this.activeTaskStartedAt = task.createdAt;
      }
    }
  }

  /** Periodic watchdog: auto-release on completion, interrupt on timeout. */
  async watchdogTick() {
    if (!this.activeTaskId) return;
    const task = this.store.get(this.activeTaskId);
    if (!task) {
      this._releaseSlot(this.activeTaskId);
      return;
    }

    if (TERMINAL_STATUSES.includes(task.status) || task.status === 'error') {
      this._releaseSlot(task.taskId);
      return;
    }

    let outcome = null;
    try {
      const resp = await this.api.getStatus(task.sessionId, this.config.opencodeApiTimeoutMs);
      outcome = resp?.data?.outcome ?? null;
    } catch {
      outcome = null;
    }

    const status = mapOutcomeToStatus(outcome);
    if (TERMINAL_STATUSES.includes(status)) {
      this.store.update(task.taskId, { status, outcome, error: null });
      this._releaseSlot(task.taskId);
      return;
    }

    if (this.now() - this.activeTaskStartedAt > this.config.taskExecutionTimeoutMs) {
      const interrupted = await this._interruptAndConfirm(task);
      if (interrupted) {
        this.store.update(task.taskId, { status: 'cancelled', outcome: 'interrupted', error: 'timed out' });
        this._releaseSlot(task.taskId);
      } else {
        // Interrupt not confirmed: keep tracking, hold the slot, block the next task.
        this.store.update(task.taskId, { status: 'unknown', outcome: null, error: 'timeout interrupt not confirmed' });
      }
    }
  }
}
