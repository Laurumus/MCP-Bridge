import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { Executor } from '../src/executor.js';
import { BearerAuth } from '../src/auth.js';
import { startServer } from '../src/server.js';

const TOKEN = 'test-token-http-000';

// Minimal fake: isolation is NOT confirmed (getAgent returns null), so real
// submissions refuse safely. No real `opencode` is ever invoked.
const api = {
  async getAgent() { return { data: null }; },
};

function makeContext() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-http-'));
  const store = new Store(path.join(dir, 'tasks.db'));
  // The model is mandatory configuration even though submissions are refused.
  const executor = new Executor({
    api,
    store,
    config: { executorAgent: 'executor', executorModel: 'apmix/deepseek-v4.1-flash-1017', opencodeApiTimeoutMs: 1000 },
  });
  const auth = new BearerAuth(TOKEN);
  return { dir, store, executor, auth };
}

function clientTransport(url, token = TOKEN) {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

test('HTTP lifecycle: initialize, list, disconnect, re-initialize, auth at each stage', async () => {
  const { dir, executor, auth } = makeContext();
  const config = { host: '127.0.0.1', port: 0, maxRequestBodySize: 1024 * 1024, maxSessions: 100 };
  const { port, sessions, close } = await startServer({ executor, auth, config });
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    // --- auth on raw POST initialize ---
    let resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(resp.status, 401, 'no token must be rejected');
    await resp.text();

    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(resp.status, 401, 'wrong token must be rejected');
    await resp.text();

    // --- client 1: initialize + tools/list ---
    const t1 = clientTransport(url);
    const c1 = new Client({ name: 'client1', version: '0.0.0' });
    await c1.connect(t1);
    const sid1 = t1.sessionId;
    assert.ok(sid1, 'client1 must receive a session id');

    const tools1 = await c1.listTools();
    assert.equal(tools1.tools.length, 4);

    // --- auth on GET / POST / DELETE with a valid session id but no token ---
    resp = await fetch(url, { method: 'GET', headers: { 'mcp-session-id': sid1 } });
    assert.equal(resp.status, 401, 'GET without token must be rejected');
    await resp.text();

    resp = await fetch(url, {
      method: 'POST',
      headers: { 'mcp-session-id': sid1, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(resp.status, 401, 'POST without token must be rejected');
    await resp.text();

    resp = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid1 } });
    assert.equal(resp.status, 401, 'DELETE without token must be rejected');
    await resp.text();

    // --- disconnect client 1 ---
    await c1.close();
    assert.equal(sessions.size, 1, 'transport stays registered until explicit termination');

    // --- terminate client 1 session (DELETE with token) ---
    resp = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid1, authorization: `Bearer ${TOKEN}` } });
    assert.equal(resp.status, 200, 'DELETE with token must be accepted');
    await resp.text();
    assert.equal(sessions.size, 0, 'session removed after termination');

    // --- client 2: fresh initialize WITHOUT process restart ---
    const t2 = clientTransport(url);
    const c2 = new Client({ name: 'client2', version: '0.0.0' });
    await c2.connect(t2);
    assert.ok(t2.sessionId, 'client2 must receive a new session id');
    assert.notEqual(t2.sessionId, sid1, 'new client gets a new session id');

    const tools2 = await c2.listTools();
    assert.equal(tools2.tools.length, 4);

    // --- safe refusal: submit_task must refuse (executor agent missing) ---
    const submit = await c2.callTool({ name: 'submit_task', arguments: { prompt: 'hello' } });
    const submitText = submit.content.map((c) => c.text).join('\n');
    assert.equal(submit.isError, true);
    assert.match(submitText, /EXECUTOR_UNAVAILABLE/);

    // --- unknown task id ---
    const status = await c2.callTool({ name: 'get_task_status', arguments: { taskID: 'task_nope' } });
    const statusText = status.content.map((c) => c.text).join('\n');
    assert.equal(status.isError, true);
    assert.match(statusText, /NOT_FOUND/);

    // --- invalid arguments are rejected with a safe code (not a raw message) ---
    const bad = await c2.callTool({ name: 'submit_task', arguments: {} });
    const badText = bad.content.map((c) => c.text).join('\n');
    assert.equal(bad.isError, true);
    assert.match(badText, /INVALID_ARGUMENT/);
    assert.ok(!badText.includes('prompt'), 'raw error detail must not leak to the client');

    await c2.close();
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
