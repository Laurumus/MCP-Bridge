// Contract regression test: the REAL Executor wired to the REAL
// createOpencodeApi() wrapper, with a fake `opencode` subprocess.
//
// Why this exists: test/mock.test.js uses an independent FakeApi that happened
// to expose getStatus/setAgent/setModel and an object-shaped createSession,
// which hid a real break between executor.js and opencode-api.js (the wrapper
// offered switchAgent/switchModel/getSession, and executor passed a bare
// string where the wrapper expects `{ directory }`). This test therefore uses
// no FakeApi at all: every call goes through the wrapper's arg builder.
//
// Isolation: the only `opencode` binary is `spawnFn`, which returns an
// in-memory EventEmitter. Nothing is executed, no network or loopback socket is
// used, no provider is contacted. The Store lives in a mkdtemp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Executor } from '../src/executor.js';
import { Store } from '../src/store.js';
import { createOpencodeApi } from '../src/opencode-api.js';

const AGENT_ID = 'executor';
const MODEL = 'apmix/deepseek-v4.1-flash-1017';
const MODEL_REF = { providerID: 'apmix', id: 'deepseek-v4.1-flash-1017' };
const T = 2000;

/**
 * Scripted `opencode api` stand-in. `routes` maps `"<method> <path prefix>"`
 * to `{ status, body }`; the response is delivered asynchronously like a real
 * child process. Every invocation is recorded (cmd, args, cwd) so the test can
 * assert on the exact wire contract (endpoints, payload, ordering).
 */
function scriptedSpawn(routes) {
  const calls = [];
  let sessionSeq = 0; // shared: each POST /api/session hands out a new id
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ cmd, args: [...args], cwd: opts?.cwd });

    const method = args[1];
    const apiPath = args[2];
    const dataIdx = args.indexOf('--data');
    const body = dataIdx === -1 ? undefined : JSON.parse(args[dataIdx + 1]);
    const key = `${method} ${apiPath}`;
    calls[calls.length - 1].body = body;

    let route = routes[key];
    // Exact route first, then the longest path prefix, so session ids differ.
    if (!route) {
      const prefixes = Object.keys(routes).filter((r) => {
        if (!r.endsWith('/')) return false;
        // Match on a path boundary: `/api/session/` must not swallow
        // `/api/session/ses_1/agent` unless the key really is that prefix.
        return key.startsWith(r);
      });
      prefixes.sort((a, b) => b.length - a.length);
      if (prefixes.length > 0) route = routes[prefixes[0]];
    }
    if (!route) {
      route = { status: 404, body: { _tag: 'SessionNotFoundError' } };
    }

    setImmediate(() => {
      if (route.status === 0) {
        // Transport-only success with an empty body (204 No Content).
        child.emit('close', 0);
        return;
      }
      if (route.status >= 200 && route.status < 300) {
        let out = route.body;
        // `post /api/session` hands out a fresh id per call (real sessions are
        // unique), so the store's UNIQUE(session_id) is exercised honestly.
        // Routes are keyed by `ses_fake` so later calls use `<key>/*`.
        if (method === 'post' && apiPath === '/api/session') {
          sessionSeq += 1;
          out = { data: { id: sessionSeq === 1 ? 'ses_fake_1' : `ses_fake_${sessionSeq}` } };
        }
        if (out !== undefined) child.stdout.emit('data', JSON.stringify(out));
        child.emit('close', 0);
        return;
      }
      child.stderr.emit('data', `HTTP ${route.status} Error\n`);
      if (route.body !== undefined) child.stdout.emit('data', JSON.stringify(route.body));
      child.emit('close', 1);
    });
    return child;
  };
  return { spawnFn, calls };
}

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-integ-'));
  return { dir, store: new Store(path.join(dir, 'tasks.db')) };
}

function makeConfig(workdir) {
  return {
    workdir,
    executorAgent: AGENT_ID,
    executorModel: MODEL,
    opencodeApiTimeoutMs: T,
    taskExecutionTimeoutMs: 60_000,
    maxPromptLength: 10_000,
    maxResultLength: 50_000,
    agentLookupRetryDelaysMs: [0, 0, 0],
  };
}

/**
 * The routes a healthy executor session produces. `state` (agent/model/
 * outcome/cost/tokens) is read on every GET, so a test can change it between
 * getStatus calls; extra ids past `ses_fake_1` get their own empty routes.
 */
function happyRoutes(state = {}) {
  // Read by reference (not copied) so a test can mutate it between reads:
  // defaults are filled in on the caller's object itself.
  const current = Object.assign(state, {
    agent: AGENT_ID, model: MODEL_REF, outcome: null, cost: null, tokens: null, ...state,
  });
  return {
    [`get /api/agent/${AGENT_ID}`]: {
      status: 200,
      body: { data: { id: AGENT_ID, mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } },
    },
    'post /api/session': { status: 200, body: { data: { id: 'ses_fake_1' } } },
    // The wrapper must use these method names; an old switch*/getSession name
    // would throw "is not a function" here instead of returning a response.
    'post /api/session/ses_fake_1/agent': { status: 0 },
    'post /api/session/ses_fake_1/model': { status: 0 },
    'post /api/session/ses_fake_1/prompt': { status: 200, body: { data: { id: 'msg_1' } } },
    'get /api/session/ses_fake_1': {
      status: 200,
      get body() { return { data: { id: 'ses_fake_1', ...current } }; },
    },
    'get /api/session/ses_fake_1/message': { status: 200, body: { data: [], cursor: { next: null } } },
    // Sessions 2..4 (a second task) use the same fake state.
    'post /api/session/ses_fake_2/': { status: 0 },
    'post /api/session/ses_fake_3/': { status: 0 },
    'get /api/session/ses_fake_2': {
      status: 200,
      get body() { return { data: { id: 'ses_fake_2', ...current } }; },
    },
  };
}

function indexOf(calls, method, apiPath) {
  return calls.findIndex((c) => c.args[1] === method && c.args[2] === apiPath);
}

// ---------------------------------------------------------------------------

test('integration: real Executor + real wrapper submits a task end to end', async () => {
  const { dir, store } = freshStore();
  const workdir = path.join(dir, 'delegated-workdir');
  const { spawnFn, calls } = scriptedSpawn(happyRoutes());
  const api = createOpencodeApi({ spawnFn });
  const executor = new Executor({ api, store, config: makeConfig(workdir) });

  const res = await executor.submitTask('do the thing');

  assert.equal(res.status, 'submitted');
  assert.match(res.taskID, /^task_[0-9a-f]{16}$/);

  // Exactly one binary is ever invoked, always as `opencode api ...`.
  for (const c of calls) {
    assert.equal(c.cmd, 'opencode');
    assert.equal(c.args[0], 'api');
    assert.equal(c.cwd, path.resolve('.'), 'CLI cwd is the project, not the delegated workdir');
  }

  // Session creation: POST /api/session with location.directory = absolute path.
  const create = calls.filter((c) => c.args[1] === 'post' && c.args[2] === '/api/session');
  assert.equal(create.length, 1, 'exactly one session is created');
  assert.equal(path.isAbsolute(create[0].body.location.directory), true);
  // macOS /tmp symlink tolerance is irrelevant on Linux but keeps this portable.
  const expectedDir = realpathSync(dir) + '/delegated-workdir';
  assert.ok(
    create[0].body.location.directory === workdir
      || create[0].body.location.directory === expectedDir,
    `location.directory must be the configured absolute workdir, got ${create[0].body.location.directory}`,
  );
  assert.equal(create[0].body.agent, undefined, 'agent is set separately after creation');
  assert.equal(create[0].body.model, undefined, 'model is set separately after creation');

  // Agent and model are configured, with the wrapper's payload shape.
  const setAgent = indexOf(calls, 'post', '/api/session/ses_fake_1/agent');
  const setModel = indexOf(calls, 'post', '/api/session/ses_fake_1/model');
  assert.ok(setAgent !== -1, 'setAgent must reach POST /api/session/:id/agent');
  assert.ok(setModel !== -1, 'setModel must reach POST /api/session/:id/model');
  assert.deepEqual(calls[setAgent].body, { agent: AGENT_ID });
  assert.deepEqual(calls[setModel].body, { model: MODEL_REF });

  // Session state is read (getStatus) BEFORE the prompt, and the session read
  // must be the state endpoint, not the message endpoint.
  const readState = indexOf(calls, 'get', '/api/session/ses_fake_1');
  const prompt = indexOf(calls, 'post', '/api/session/ses_fake_1/prompt');
  assert.ok(readState !== -1, 'getStatus must reach GET /api/session/:id');
  assert.ok(prompt !== -1, 'the prompt must reach POST /api/session/:id/prompt');
  assert.ok(readState < prompt, 'session state is confirmed before the prompt is sent');
  assert.ok(setAgent < readState && setModel < readState, 'agent/model are set before confirmation');

  // The prompt is sent exactly once, with the task text.
  const prompts = calls.filter((c) => c.args[2] === '/api/session/ses_fake_1/prompt');
  assert.equal(prompts.length, 1, 'prompt is sent exactly once');
  assert.deepEqual(prompts[0].body, { text: 'do the thing' });

  // The bridge persisted its own task row bound to the fake session.
  const task = store.get(res.taskID);
  assert.equal(task.sessionId, 'ses_fake_1');
  assert.equal(task.status, 'pending');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('integration: getStatus through the same wiring maps the outcome', async () => {
  const { dir, store } = freshStore();
  const workdir = path.join(dir, 'w');
  // The session-state route reports the *current* state on each read.
  const state = { agent: AGENT_ID, model: MODEL_REF, outcome: null, cost: 0.5, tokens: 42 };
  const { spawnFn } = scriptedSpawn(happyRoutes(state));
  const api = createOpencodeApi({ spawnFn });
  const executor = new Executor({ api, store, config: makeConfig(workdir) });

  const { taskID } = await executor.submitTask('run');
  // Await the pending read BEFORE flipping the state: the GET resolves
  // asynchronously, so starting it and flipping in the same tick would race.
  const pending = await executor.getStatus(taskID);
  assert.equal(pending.status, 'pending_or_running');

  state.outcome = 'succeeded';
  const done = await executor.getStatus(taskID);
  assert.equal(done.status, 'completed');
  assert.equal(done.outcome, 'succeeded');
  assert.equal(done.cost, 0.5);
  assert.equal(done.tokens, 42);

  // Terminal status releases the slot: a second task may be submitted.
  const second = await executor.submitTask('run again');
  assert.equal(second.taskID === taskID, false);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('integration: a session whose agent is not the executor is refused before the prompt (agent mismatch)', async () => {
  // Honest scope: this fake keeps the requested directory and reports a
  // DIFFERENT agent, so what is proven here is the agent mismatch check on its
  // own (AGENT_MISMATCH, no prompt). The bridge does not read the session
  // directory back, so a mis-located session is not what this test detects;
  // the one assertion about the directory only records what was sent.
  const { dir, store } = freshStore();
  const workdir = path.join(dir, 'w');
  const { spawnFn, calls } = scriptedSpawn(happyRoutes({ agent: 'someone-else' }));
  const api = createOpencodeApi({ spawnFn });
  const executor = new Executor({ api, store, config: makeConfig(workdir) });

  await assert.rejects(
    () => executor.submitTask('x'),
    (e) => e.code === 'AGENT_MISMATCH',
  );
  assert.equal(
    calls.filter((c) => c.args[2] === '/api/session/ses_fake_1/prompt').length,
    0,
    'no prompt is sent when the session agent is not the executor',
  );
  // Not a directory check: records that createSession did send location.directory.
  const create = calls.find((c) => c.args[1] === 'post' && c.args[2] === '/api/session');
  assert.equal(create.body.location.directory, workdir);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('integration: invalid/absent configured model refuses before any CLI call and frees the slot', async () => {
  // Defence in depth: startup validates BRIDGE_EXECUTOR_MODEL, and submitTask
  // repeats the check before the slot/readiness/API. The real wrapper is wired
  // so a leaked call would spawn the fake CLI and show up in `calls`.
  for (const bad of [undefined, null, '', '   ', 'no-slash', '/model', 'apmix/x#']) {
    const { dir, store } = freshStore();
    const workdir = path.join(dir, 'w');
    const { spawnFn, calls } = scriptedSpawn(happyRoutes());
    const api = createOpencodeApi({ spawnFn });
    const executor = new Executor({ api, store, config: { ...makeConfig(workdir), executorModel: bad } });

    await assert.rejects(
      () => executor.submitTask('x'),
      (e) => e.code === 'BAD_CONFIG',
      `model ${JSON.stringify(bad)} must be refused`,
    );
    assert.equal(calls.length, 0, 'no CLI/API call for an invalid model');
    assert.equal(executor.activeTaskId, null, 'slot never reserved');
    assert.equal(store.listNonTerminal().length, 0, 'no task row persisted');

    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
