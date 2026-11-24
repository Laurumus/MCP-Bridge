import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Error surfaced by the `opencode api` subprocess wrapper.
 *
 * `kind` distinguishes the transport-level failure modes; `httpStatus` and
 * `tag` carry the server's structured answer (when present) so callers can
 * decide whether a request was *definitely* rejected or whether its outcome is
 * unknown. A non-zero exit code alone is NOT treated as a rejection.
 */
export class OpenCodeError extends Error {
  constructor(message, kind, { httpStatus = null, tag = null } = {}) {
    super(message);
    this.name = 'OpenCodeError';
    this.kind = kind; // 'exit' | 'non-json' | 'spawn' | 'timeout'
    this.httpStatus = httpStatus; // number | null
    this.tag = tag; // string | null
  }
}

/**
 * Server error tags that unambiguously mean the request was rejected before or
 * without running anything. Used only as a fallback when the HTTP status code
 * could not be parsed from stderr.
 */
const DEFINITE_REJECTION_TAGS = new Set([
  'InvalidRequestError', // 400
  'UnauthorizedError', // 401
  'ForbiddenError', // 403
  'SessionNotFoundError', // 404
  'AgentNotFoundError', // 404
  'ModelNotFoundError', // 404
  'LocationNotFoundError', // 404
  // `SessionBusyError` (409) is deliberately NOT here: whether a 409 means the
  // request was refused without running anything is not proven for every
  // endpoint, so it stays ambiguous (see DEFINITE_REJECTION_STATUS).
]);

/**
 * HTTP status codes that are a definite rejection of the request.
 * 409 (session busy) is deliberately excluded: it stays ambiguous until the
 * API contract is established, so the executor keeps the task and the slot.
 */
const DEFINITE_REJECTION_STATUS = new Set([400, 401, 403, 404]);

/**
 * Classify an error from the subprocess wrapper into an outcome the executor
 * can act on safely. Only two results exist:
 *
 * - 'ambiguous': the request may or may not have taken effect on the OpenCode
 *   side, so the executor MUST NOT retry and MUST keep the task tracked and
 *   the slot held. This is the DEFAULT for anything not clearly a rejection:
 *   `timeout`, `non-json`, `HTTP 409`, `429`, `5xx`, and any non-zero exit
 *   whose status/tag we could not read.
 * - 'definite': we know the request was rejected and nothing ran. `spawn`
 *   (CLI never started) and a small, explicit set of `4xx` rejections.
 */
export function classifyError(e) {
  if (!e) return 'ambiguous';
  if (e.kind === 'spawn') return 'definite';
  if (e.kind === 'timeout') return 'ambiguous';
  if (e.kind === 'non-json') return 'ambiguous';
  if (e.kind === 'exit') {
    if (typeof e.httpStatus === 'number') {
      if (DEFINITE_REJECTION_STATUS.has(e.httpStatus)) return 'definite';
      // 429 (rate limit), 5xx, and any other code: outcome unknown.
      return 'ambiguous';
    }
    // No status parsed: fall back to the server's error tag, else ambiguous.
    if (typeof e.tag === 'string' && DEFINITE_REJECTION_TAGS.has(e.tag)) {
      return 'definite';
    }
    return 'ambiguous';
  }
  // Unknown kind: conservative default is ambiguous.
  return 'ambiguous';
}

export function isAmbiguousError(e) {
  return classifyError(e) === 'ambiguous';
}

export function isDefiniteRejection(e) {
  return classifyError(e) === 'definite';
}

/**
 * Convert a model reference into the `Model.Ref` object the session model API
 * expects: `{ id, providerID, variant? }`. Accepts either a
 * `"providerID/model"` (optionally `"providerID/model#variant"`) string or an
 * already-shaped object. Returns null when the input is not a valid reference.
 *
 * OpenCode's own `"provider/model"` form never starts with "/" and never has an
 * empty model part, so both are rejected here instead of being sent upstream.
 *
 * The string and object forms share one validator (fieldShapeError) so they
 * cannot drift apart:
 * - string: the WHOLE reference is trimmed once, then split on the first "/"
 *   and at most one "#";
 * - object: fields are taken verbatim (no trimming), so a field that carries
 *   surrounding or inner whitespace is rejected rather than silently cleaned.
 * In both forms: providerID is non-empty without whitespace, "/" or "#"; id is
 * non-empty without whitespace or "#", but inner "/" IS allowed (namespaced
 * model ids); variant, when present (null/undefined = absent), is a non-empty
 * string without whitespace or "#" and is never trimmed silently.
 */
function modelRefFieldError(providerID, id, variant) {
  if (typeof providerID !== 'string' || providerID === '') return 'providerID';
  if (/\s/.test(providerID) || providerID.includes('/') || providerID.includes('#')) return 'providerID';
  if (typeof id !== 'string' || id === '') return 'id';
  if (/\s/.test(id) || id.includes('#')) return 'id';
  if (variant === undefined || variant === null) return null;
  if (typeof variant !== 'string' || variant === '') return 'variant';
  if (/\s/.test(variant) || variant.includes('#')) return 'variant';
  return null;
}

export function parseModelRef(model) {
  if (model && typeof model === 'object') {
    const { providerID, id, variant } = model;
    if (modelRefFieldError(providerID, id, variant)) return null;
    const ref = { id, providerID };
    if (variant !== undefined && variant !== null) ref.variant = variant;
    return ref;
  }
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed === '') return null;
  // Implicit String#split only returns the second element: test the count
  // explicitly so "a/b#x#y" is rejected instead of silently truncated.
  const parts = trimmed.split('#');
  if (parts.length > 2) return null;
  const head = parts[0];
  const slash = head.indexOf('/');
  if (slash <= 0 || slash === head.length - 1) return null;
  const providerID = head.slice(0, slash);
  const id = head.slice(slash + 1);
  const variant = parts.length === 2 ? parts[1] : undefined;
  if (modelRefFieldError(providerID, id, variant)) return null;
  const ref = { providerID, id };
  if (variant !== undefined) ref.variant = variant;
  return ref;
}

/**
 * True when `actual` (the model a live session/response reports, a Model.Ref
 * or Model.Info) is the model described by `expected` (a Model.Ref). The
 * variant is compared only when expected names one: OpenCode's catalog default
 * does not retain a variant, so an unset variant on either side is no mismatch.
 */
export function modelRefMatches(expected, actual) {
  if (!expected || !actual) return false;
  if (actual.providerID !== expected.providerID || actual.id !== expected.id) return false;
  if (expected.variant && actual.variant !== expected.variant) return false;
  return true;
}

export function describeModelRef(ref) {
  if (!ref) return null;
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}

export function parseHttpStatus(stderr) {
  // The CLI prints a single status line, e.g. "HTTP 404 Not Found\n". Only a
  // standalone status line is accepted: it must begin a line ("HTTP"), then a
  // 3-digit code, then a reason phrase. A code embedded inside a diagnostic
  // string (e.g. "some diagnostic: HTTP 404 Not Found") yields null.
  const m = /^HTTP\s+(\d{3})\s+\S/m.exec(stderr || '');
  return m ? parseInt(m[1], 10) : null;
}

export function parseTag(stdout) {
  try {
    const obj = JSON.parse(stdout || '');
    return typeof obj._tag === 'string' ? obj._tag : null;
  } catch {
    return null;
  }
}

/**
 * Build a client for the OpenCode HTTP API reached through
 * `opencode api <method> <path> [--data <json>]`.
 *
 * - the CLI is invoked as an argument vector (never through a shell), so no
 *   value can be interpreted as shell syntax;
 * - relative paths are resolved against the checked-out project, never against
 *   the session directory, because `opencode api` rejects `..` segments;
 * - `BRIDGE_WORKDIR` is deliberately NOT the subprocess cwd: the CLI would then
 *   load a project `opencode.json` from the delegated directory, which could
 *   define or override the executor agent. The session directory is passed to
 *   the server explicitly (`location.directory` on session create instead);
 * - the subprocess inherits `process.env` only;
 * - the timeout kills the CLI and is reported as ambiguous;
 * - `spawnFn` is injectable for tests; production uses node:child_process.spawn.
 */
export function createOpencodeApi({ spawnFn = nodeSpawn } = {}) {
  function runApi(method, apiPath, { data, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const args = ['api', method.toLowerCase(), apiPath];
      if (data !== undefined) {
        args.push('--data', JSON.stringify(data));
      }

      let child;
      try {
        child = spawnFn('opencode', args, {
          cwd: path.resolve('.'),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new OpenCodeError(`failed to spawn opencode: ${err.message}`, 'spawn'));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new OpenCodeError(`opencode api timed out after ${timeoutMs}ms`, 'timeout'));
      }, timeoutMs);

      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new OpenCodeError(`failed to spawn opencode: ${err.message}`, 'spawn'));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = (stderr || stdout).trim().slice(0, 2000);
          reject(new OpenCodeError(
            `opencode api exited ${code}: ${detail}`,
            'exit',
            { httpStatus: parseHttpStatus(stderr), tag: parseTag(stdout) },
          ));
          return;
        }
        // 204 No Content (e.g. setAgent / setModel) yields an empty body
        // on a zero exit. Treat it as a successful empty response, not an error.
        if (stdout.trim() === '') {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new OpenCodeError('opencode api returned non-JSON output', 'non-json'));
        }
      });
    });
  }

  return {
    /**
     * Create a session in an explicit directory. `agent` and `model` are
     * optional here; when omitted the server applies its defaults, and the
     * caller reads back what was actually selected. (The bridge itself always
     * follows up with setAgent/setModel from its own required configuration.)
     */
    createSession({ directory, agent, model } = {}, timeoutMs) {
      const body = {};
      if (directory) body.location = { directory };
      if (agent) body.agent = agent;
      if (model) body.model = model;
      return runApi('post', '/api/session', { data: body, timeoutMs });
    },

    setAgent(sessionId, agent, timeoutMs) {
      return runApi('post', `/api/session/${sessionId}/agent`, { data: { agent }, timeoutMs });
    },

    setModel(sessionId, model, timeoutMs) {
      const ref = parseModelRef(model);
      if (!ref) {
        return Promise.reject(new OpenCodeError(
          `invalid model reference: ${String(model)}`,
          'exit',
          { httpStatus: 400 },
        ));
      }
      return runApi('post', `/api/session/${sessionId}/model`, { data: { model: ref }, timeoutMs });
    },

    sendPrompt(sessionId, text, timeoutMs) {
      return runApi('post', `/api/session/${sessionId}/prompt`, { data: { text }, timeoutMs });
    },

    /**
     * Read the live session state (agent, model, outcome) that the executor
     * confirms before sending a prompt and polls while a task runs.
     */
    getStatus(sessionId, timeoutMs) {
      return runApi('get', `/api/session/${sessionId}`, { timeoutMs });
    },

    getMessages(sessionId, cursor, timeoutMs) {
      const query = new URLSearchParams({ type: 'assistant' });
      if (cursor) query.set('cursor', cursor);
      return runApi('get', `/api/session/${sessionId}/message?${query.toString()}`, { timeoutMs });
    },

    interrupt(sessionId, timeoutMs) {
      return runApi('post', `/api/session/${sessionId}/interrupt`, { timeoutMs });
    },

    getAgent(agentId, timeoutMs) {
      return runApi('get', `/api/agent/${encodeURIComponent(agentId)}`, { timeoutMs });
    },

    getModel(modelId, timeoutMs) {
      return runApi('get', `/api/model/${encodeURIComponent(modelId)}`, { timeoutMs });
    },
  };
}

/** Production client. `src/main.js` is the only module that uses it. */
export const OpenCodeAPI = createOpencodeApi();
