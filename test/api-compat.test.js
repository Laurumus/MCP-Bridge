// Compatibility tests for the refactored src/config.js and src/opencode-api.js.
//
// Isolated: every `opencode` subprocess is a FakeChild object returned by an
// injected spawnFn; the real CLI, the real OpenCode server, providers and any
// paid request are never touched. No network, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { parseExecutorModelSetting, isLoopbackHost } from '../src/config.js';
import {
  OpenCodeError,
  classifyError,
  parseModelRef,
  modelRefMatches,
  describeModelRef,
  createOpencodeApi,
} from '../src/opencode-api.js';

/** Minimal child_process stand-in: emits close(code) after spawn returns. */
function fakeChild({ code = 0, stdout = '', stderr = '', closeAfter = 1 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (closeAfter !== 0) {
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
  }
  return child;
}

function apiWith(childFactory) {
  const calls = [];
  const api = createOpencodeApi({
    spawnFn: (cmd, args, opts) => {
      const child = childFactory(cmd, args, opts);
      calls.push({ cmd, args, opts });
      return child;
    },
  });
  return { api, calls };
}

const T = 1000;

// ---------------------------------------------------------------------------
// config: optional model + loopback
// ---------------------------------------------------------------------------

test('config: empty/unset executor model means "let OpenCode choose" (null)', () => {
  assert.equal(parseExecutorModelSetting(undefined), null);
  assert.equal(parseExecutorModelSetting(''), null);
  assert.equal(parseExecutorModelSetting('   '), null);
  assert.equal(parseExecutorModelSetting('opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(parseExecutorModelSetting(' opencode/big-pickle '), 'opencode/big-pickle');
});

test('config: loopback detection accepts only loopback names', () => {
  for (const h of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ['0.0.0.0', '10.0.0.5', 'example.com', '', null, undefined]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

// ---------------------------------------------------------------------------
// 204 (empty body) on a successful call
// ---------------------------------------------------------------------------

test('api: empty body on zero exit (204) resolves to {} — setModel path', async () => {
  const { api, calls } = apiWith(() => fakeChild({ code: 0, stdout: '' }));
  const res = await api.switchModel('ses_1', 'opencode/big-pickle', T);
  assert.deepEqual(res, {});
  assert.deepEqual(calls[0].args, [
    'api', 'post', '/api/session/ses_1/model',
    '--data', JSON.stringify({ model: { providerID: 'opencode', id: 'big-pickle' } }),
  ]);
  assert.equal(calls[0].cmd, 'opencode');
  assert.equal(calls[0].opts.cwd, path.resolve('.'), 'cwd is the project, never BRIDGE_WORKDIR');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('api: invalid model ref is a definite 400 and never spawns', async () => {
  const { api, calls } = apiWith(() => fakeChild());
  await assert.rejects(
    () => api.switchModel('ses_1', '', T),
    (e) => e instanceof OpenCodeError && e.httpStatus === 400 && classifyError(e) === 'definite',
  );
  assert.equal(calls.length, 0);
});

test('api: non-zero exit with HTTP status is classified, status read from stderr', async () => {
  const { api } = apiWith(() => fakeChild({ code: 1, stderr: 'HTTP 404 Not Found\n' }));
  await assert.rejects(
    () => api.getSession('ses_x', T),
    (e) => e.kind === 'exit' && e.httpStatus === 404 && classifyError(e) === 'definite',
  );
});

test('api: HTTP 409 (session busy) is a definite rejection', async () => {
  const { api } = apiWith(() => fakeChild({ code: 1, stderr: 'HTTP 409 Conflict\n' }));
  await assert.rejects(
    () => api.sendPrompt('ses_x', 'hi', T),
    (e) => e.httpStatus === 409 && classifyError(e) === 'definite',
  );
});

test('api: non-JSON success body and timeout stay ambiguous', async () => {
  const { api: api1 } = apiWith(() => fakeChild({ code: 0, stdout: 'not json' }));
  await assert.rejects(
    () => api1.getAgent('executor', T),
    (e) => e.kind === 'non-json' && classifyError(e) === 'ambiguous',
  );
  const { api: api2 } = apiWith(() => fakeChild({ closeAfter: 0 }));
  await assert.rejects(
    () => api2.getAgent('executor', 50),
    (e) => e.kind === 'timeout' && classifyError(e) === 'ambiguous',
  );
});

test('api: an async spawn error (missing CLI) is a definite spawn failure', async () => {
  const { api } = apiWith(() => {
    const child = fakeChild({ closeAfter: 0 });
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  });
  await assert.rejects(
    () => api.getAgent('executor', T),
    (e) => e.kind === 'spawn' && classifyError(e) === 'definite',
  );
});

test('api: a synchronously throwing spawnFn is a definite spawn failure', async () => {
  const api = createOpencodeApi({ spawnFn: () => { throw new Error('EACCES'); } });
  await assert.rejects(
    () => api.getAgent('executor', T),
    (e) => e.kind === 'spawn' && classifyError(e) === 'definite',
  );
});

// ---------------------------------------------------------------------------
// model reference helpers
// ---------------------------------------------------------------------------

test('api: parseModelRef / modelRefMatches / describeModelRef agree', () => {
  assert.equal(parseModelRef('opencode/'), null);
  assert.equal(parseModelRef('/model'), null);
  const expected = parseModelRef('opencode/big-pickle');
  assert.equal(modelRefMatches(expected, { providerID: 'opencode', id: 'big-pickle' }), true);
  assert.equal(modelRefMatches(expected, { providerID: 'opencode', id: 'big-pickle', variant: 'x' }), true,
    'unexpected variant on the actual side is not a mismatch');
  assert.equal(modelRefMatches(expected, { providerID: 'other', id: 'big-pickle' }), false);
  assert.equal(modelRefMatches(parseModelRef('opencode/big-pickle#high'), { providerID: 'opencode', id: 'big-pickle' }), false);
  assert.equal(describeModelRef(expected), 'opencode/big-pickle');
  assert.equal(describeModelRef(null), null);
});
