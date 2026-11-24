import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Store } from '../src/store.js';
import {
  Executor,
  summarizeToolPart,
  describeToolError,
  TOOL_CALL_ERROR_MAX_LENGTH,
} from '../src/executor.js';
import { redactSecrets, REDACTED } from '../src/sanitize.js';
import { buildServer } from '../src/server.js';

// All data below is artificial. Nothing here talks to OpenCode, the network or
// a model: the API is a scripted fake and the store lives in a temp dir.

const CONFIG = {
  workdir: '/tmp/opencode/bridge-workdir',
  executorAgent: 'executor',
  executorModel: 'apmix/deepseek-v4.1-flash-1017',
  opencodeApiTimeoutMs: 1000,
  taskExecutionTimeoutMs: 60_000,
  maxPromptLength: 10_000,
  maxResultLength: 50_000,
  agentLookupRetryDelaysMs: [0, 0, 0],
};

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-toolerr-'));
  const store = new Store(path.join(dir, 'tasks.db'));
  return { dir, store };
}

/** Minimal scripted API: enough for submitTask + getResult. */
function fakeApi(getMessages, outcome = 'succeeded') {
  return {
    async createSession() { return { data: { id: 'ses_fake_1' } }; },
    async setAgent() { return {}; },
    async setModel() { return {}; },
    async getStatus() {
      return { data: { id: 'ses_fake_1', agent: 'executor', model: { id: 'deepseek-v4.1-flash-1017', providerID: 'apmix' }, outcome, cost: null, tokens: null } };
    },
    async sendPrompt() { return { data: { id: 'msg_1' } }; },
    async interrupt() { return { interrupted: true }; },
    async getAgent() {
      return { data: { id: 'executor', mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'allow' }] } };
    },
    async getMessages() { return getMessages(); },
  };
}

function messages(parts) {
  return { data: [{ type: 'assistant', content: parts }], cursor: { next: null } };
}

/** Design-doc-shaped tool part as returned by OpenCode for a failed write. */
function failedWritePart({ error, extra = {} } = {}) {
  return {
    type: 'tool',
    name: 'write',
    callID: 'call_w_1',
    state: {
      status: 'error',
      input: { filePath: '/tmp/opencode/fake.txt', content: 'ARTIFICIAL_INPUT_MUST_NOT_LEAK' },
      error: error ?? 'EACCES: permission denied, open \'/tmp/opencode/fake.txt\'',
      time: { start: 1, end: 2 },
      ...extra,
    },
  };
}

async function runGetResult(getMessages, config = CONFIG) {
  const { dir, store } = freshStore();
  const ex = new Executor({ api: fakeApi(getMessages), store, config: { ...CONFIG, ...config } });
  const { taskID } = await ex.submitTask('hello');
  const res = await ex.getResult(taskID);
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return res;
}

// ---------------------------------------------------------------------------
// 1. Regression: a failed write's message reaches get_task_result
// ---------------------------------------------------------------------------

test('toolCalls: failed write carries its error message and callID in get_task_result', async () => {
  const res = await runGetResult(() => messages([
    { type: 'text', text: 'done' },
    failedWritePart(),
  ]));

  assert.equal(res.toolCalls.length, 1);
  const [call] = res.toolCalls;
  assert.equal(call.name, 'write');
  assert.equal(call.status, 'error');
  assert.match(call.error, /EACCES: permission denied/);
  assert.equal(call.callID, 'call_w_1');
  assert.equal(res.status, 'partial', 'an errored tool call still yields partial');
  // Input/arguments are never exported.
  assert.equal(JSON.stringify(res.toolCalls).includes('ARTIFICIAL_INPUT_MUST_NOT_LEAK'), false);
});

test('toolCalls: backward compatible when no tool errored', async () => {
  const res = await runGetResult(() => messages([
    { type: 'text', text: 'ok' },
    { type: 'tool', name: 'read', state: { status: 'completed', output: 'FULL_OUTPUT_MUST_NOT_LEAK' } },
    { type: 'tool', name: 'glob' },
  ]));

  assert.deepEqual(res.toolCalls, [
    { name: 'read', status: 'completed' },
    { name: 'glob', status: null },
  ]);
  assert.equal(res.status, 'completed');
  assert.equal(JSON.stringify(res.toolCalls).includes('FULL_OUTPUT_MUST_NOT_LEAK'), false);
});

// ---------------------------------------------------------------------------
// 2. Error value shapes: string / object / null / missing
// ---------------------------------------------------------------------------

test('tool error: string, object, null and missing are normalised without throwing', () => {
  const fromString = summarizeToolPart({ type: 'tool', name: 'write', state: { status: 'error', error: 'disk full' } });
  assert.deepEqual(fromString, { name: 'write', status: 'error', error: 'disk full' });

  const fromObject = summarizeToolPart({
    type: 'tool', name: 'write', toolCallID: 'call_x',
    state: { status: 'error', error: { name: 'ToolError', message: 'invalid path', code: 'EINVAL' } },
  });
  assert.equal(fromObject.error, 'invalid path');
  assert.equal(fromObject.callID, 'call_x');

  const fromNestedObject = summarizeToolPart({
    type: 'tool', name: 'bash', state: { status: 'error', error: { code: 'ENOENT', path: 'nope.sh' } },
  });
  assert.match(fromNestedObject.error, /code: ENOENT/);
  assert.match(fromNestedObject.error, /path: nope\.sh/);
  assert.equal('callID' in fromNestedObject, false, 'no callID is invented');

  const fromNull = summarizeToolPart({ type: 'tool', name: 'write', state: { status: 'error', error: null } });
  assert.deepEqual(fromNull, { name: 'write', status: 'error' }, 'null error adds nothing');

  const fromMissing = summarizeToolPart({ type: 'tool', name: 'write', state: { status: 'error' } });
  assert.deepEqual(fromMissing, { name: 'write', status: 'error' });

  assert.equal(describeToolError(null), null);
  assert.equal(describeToolError({}), null);
});

test('tool error: circular and deeply nested objects terminate', () => {
  const cyc = { message: undefined, a: 'one' };
  cyc.self = cyc;
  delete cyc.message; // fall through to the bounded walk
  const s = describeToolError({ error: cyc });
  assert.match(s, /a: one/);
  assert.match(s, /\[circular\]/);

  let deep = { leaf: 'bottom' };
  for (let i = 0; i < 50; i++) deep = { [ `k${i}` ]: deep };
  const out = describeToolError({ error: deep });
  assert.equal(out, null, 'nothing reachable within the bounded depth: no explanation invented');

  const throwing = { get message() { throw new Error('boom'); } };
  assert.doesNotThrow(() => summarizeToolPart({ type: 'tool', name: 'write', state: { status: 'error', error: throwing } }));
});

// ---------------------------------------------------------------------------
// 3. Secret redaction of error explanations
// ---------------------------------------------------------------------------

test('sanitize: artificial secrets are redacted in a tool error', () => {
  const cases = [
    ['command failed: Authorization: Bearer artificial-token-value-123', /artificial-token-value-123/],
    ['curl -H "Authorization: Bearer abcDEF123456" failed', /abcDEF123456/],
    ['request failed (bearer zzZzSecretValue) ', /zzZzSecretValue/],
    ['api_key=AIzaArtificialFakeKey123 rejected', /AIzaArtificialFakeKey123/],
    ['{"password":"fake-password-artificial"}', /fake-password-artificial/],
    ['token: faketoken123456789', /faketoken123456789/],
    ['key sk-artificial0000000000 not accepted', /artificial0000000000/],
    ['X-Api-Key: AIzaOtherFakeValue', /AIzaOtherFakeValue/],
  ];
  for (const [input, secretRe] of cases) {
    const out = redactSecrets(input);
    assert.equal(secretRe.test(out), false, `secret must not survive: ${secretRe}`);
    assert.ok(out.includes(REDACTED), `REDACTED marker expected in: ${out}`);
  }
  // Harmless text is untouched, and the helper never throws on odd input.
  assert.equal(redactSecrets('plain failure: file not found'), 'plain failure: file not found');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(42), '');
});

test('tool error: secrets inside the error are redacted before reaching the client', async () => {
  const res = await runGetResult(() => messages([
    failedWritePart({ error: 'open failed: Authorization: Bearer artificialBearerSecret77 / api_key=fakeKeyValue9' }),
  ]));
  const call = res.toolCalls[0];
  assert.ok(call.error.includes('open failed'));
  assert.equal(call.error.includes('artificialBearerSecret77'), false);
  assert.equal(call.error.includes('fakeKeyValue9'), false);
});

// ---------------------------------------------------------------------------
// 4. Long errors are bounded
// ---------------------------------------------------------------------------

test('tool error: a very long message is capped', async () => {
  const res = await runGetResult(() => messages([
    failedWritePart({ error: 'x'.repeat(100_000) }),
  ]));
  const call = res.toolCalls[0];
  assert.ok(call.error.length <= TOOL_CALL_ERROR_MAX_LENGTH + 1, `got ${call.error.length}`);
  assert.ok(call.error.endsWith('…'));
});

test('tool error: budget still applies to the enriched toolCalls', async () => {
  const res = await runGetResult(
    () => messages([
      { type: 'text', text: 'y'.repeat(1000) },
      failedWritePart({ error: 'z'.repeat(500) }),
    ]),
    { maxResultLength: 400 },
  );
  const total = res.result.length + JSON.stringify(res.toolCalls).length;
  assert.ok(total <= 400, `total ${total} must be <= 400`);
});

// ---------------------------------------------------------------------------
// 5. The new fields survive persistence and reach the MCP client
// ---------------------------------------------------------------------------

test('persistence: the task row keeps outcome/status after the diagnostic read', async () => {
  const { dir, store } = freshStore();
  const ex = new Executor({
    api: fakeApi(() => messages([failedWritePart(), { type: 'text', text: 'x' }])),
    store,
    config: CONFIG,
  });
  const { taskID } = await ex.submitTask('hello');
  await ex.getResult(taskID);

  // getResult does not write toolCalls to the DB (they are per-read, from the
  // session API); the task row must still be readable afterwards and keep the
  // same terminal outcome without clobbering the stored error field.
  const row = store.get(taskID);
  assert.equal(row.taskId, taskID);
  assert.equal(row.sessionId, 'ses_fake_1');
  assert.equal(row.error, null);
  // outcome is not written back by getResult; the row keeps what submitTask stored.
  assert.equal(row.outcome, null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('persistence: reading the same result twice keeps the diagnostic verbatim', async () => {
  const { dir, store } = freshStore();
  const ex = new Executor({ api: fakeApi(() => messages([failedWritePart()])), store, config: CONFIG });
  const { taskID } = await ex.submitTask('hello');
  const first = await ex.getResult(taskID);
  const second = await ex.getResult(taskID);
  assert.deepEqual(second.toolCalls, first.toolCalls);
  assert.equal(second.toolCalls[0].error, first.toolCalls[0].error);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('end to end: get_task_result tool returns the error diagnostic as JSON text', async () => {
  const { dir, store } = freshStore();
  const ex = new Executor({ api: fakeApi(() => messages([failedWritePart()])), store, config: CONFIG });
  const { taskID } = await ex.submitTask('hello');

  const server = buildServer(ex);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const resp = await client.callTool({ name: 'get_task_result', arguments: { taskID } });
    const payload = JSON.parse(resp.content[0].text);
    assert.equal(payload.taskID, taskID);
    assert.equal(payload.toolCalls[0].name, 'write');
    assert.equal(payload.toolCalls[0].status, 'error');
    assert.match(payload.toolCalls[0].error, /EACCES/);
    assert.equal(JSON.stringify(payload).includes('ARTIFICIAL_INPUT_MUST_NOT_LEAK'), false);
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});