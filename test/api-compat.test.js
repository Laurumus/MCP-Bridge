// Compatibility tests for the refactored src/config.js and src/opencode-api.js.
//
// Isolated: every `opencode` subprocess is a FakeChild object returned by an
// injected spawnFn; the real CLI, the real OpenCode server, providers and any
// paid request are never touched. No network, no files written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { parseExecutorModelSetting, validateExecutorModel, isLoopbackHost } from '../src/config.js';
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
// config: mandatory model + loopback
// ---------------------------------------------------------------------------

test('config: unset/empty model normalizes to null (= not configured, never a fallback)', () => {
  assert.equal(parseExecutorModelSetting(undefined), null);
  assert.equal(parseExecutorModelSetting(''), null);
  assert.equal(parseExecutorModelSetting('   '), null);
  assert.equal(parseExecutorModelSetting(null), null);
  assert.equal(parseExecutorModelSetting(42), null);
  assert.equal(parseExecutorModelSetting('opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(parseExecutorModelSetting(' opencode/big-pickle '), 'opencode/big-pickle');
});

test('config: validateExecutorModel requires a valid provider/model reference', () => {
  for (const bad of [undefined, '', '   ', 'no-slash', '/model', 'provider/', ' / ', 'a/b#']) {
    const r = validateExecutorModel(bad);
    assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.match(r.message, /BRIDGE_EXECUTOR_MODEL/);
    assert.equal(r.model, undefined, 'no fallback model on failure');
  }
  assert.deepEqual(validateExecutorModel(' apmix/deepseek-v4.1-flash-1017 '), {
    ok: true, model: 'apmix/deepseek-v4.1-flash-1017',
  });
  assert.deepEqual(validateExecutorModel('opencode/big-pickle#high'), {
    ok: true, model: 'opencode/big-pickle#high',
  });
});

test('config: validateExecutorModel never echoes the rejected value', () => {
  const SECRET_SENTINEL = 'SECRET_SENTINEL_sk_live_do_not_print';
  for (const bad of [SECRET_SENTINEL, `prov/${SECRET_SENTINEL}#`, `prov/prod #${SECRET_SENTINEL}`, `${SECRET_SENTINEL}/model#a#b`, `/model#${SECRET_SENTINEL}`]) {
    const r = validateExecutorModel(bad);
    assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.match(r.message, /BRIDGE_EXECUTOR_MODEL/);
    assert.match(r.message, /provider\/model/, 'format hint stays in the message');
    assert.equal(r.message.includes(SECRET_SENTINEL), false, 'message must not contain the value');
    assert.equal(r.message.includes('SECRET_SENTINEL'), false, 'message must not contain the value');
  }
});

test('config: validateExecutorModel validates exactly its argument (no env default)', () => {
  const prev = process.env.BRIDGE_EXECUTOR_MODEL;
  process.env.BRIDGE_EXECUTOR_MODEL = 'opencode/big-pickle';
  try {
    // Even though the environment holds a valid model, an explicit undefined
    // stays an error: main.js passes config.executorModel itself.
    const r = validateExecutorModel(undefined);
    assert.equal(r.ok, false, 'undefined must stay an error regardless of env');
    assert.match(r.message, /unset/);
    assert.equal(r.model, undefined);
  } finally {
    if (prev === undefined) delete process.env.BRIDGE_EXECUTOR_MODEL;
    else process.env.BRIDGE_EXECUTOR_MODEL = prev;
  }
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
  const res = await api.setModel('ses_1', 'opencode/big-pickle', T);
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
    () => api.setModel('ses_1', '', T),
    (e) => e instanceof OpenCodeError && e.httpStatus === 400 && classifyError(e) === 'definite',
  );
  assert.equal(calls.length, 0);
});

test('api: non-zero exit with HTTP status is classified, status read from stderr', async () => {
  const { api } = apiWith(() => fakeChild({ code: 1, stderr: 'HTTP 404 Not Found\n' }));
  await assert.rejects(
    () => api.getStatus('ses_x', T),
    (e) => e.kind === 'exit' && e.httpStatus === 404 && classifyError(e) === 'definite',
  );
});

test('api: HTTP 409 (session busy) stays ambiguous (conservative)', async () => {
  const { api } = apiWith(() => fakeChild({ code: 1, stderr: 'HTTP 409 Conflict\n' }));
  await assert.rejects(
    () => api.sendPrompt('ses_x', 'hi', T),
    (e) => e.httpStatus === 409 && classifyError(e) === 'ambiguous',
  );
  // The tag alone is not a definite rejection either (no status parsed).
  assert.equal(classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'SessionBusyError' })), 'ambiguous');
  // ...while an unambiguous tag without a status still is.
  assert.equal(classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'InvalidRequestError' })), 'definite');
  assert.equal(classifyError(new OpenCodeError('x', 'exit', { httpStatus: null, tag: 'ModelNotFoundError' })), 'definite');
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
  // Whitespace-only parts, extra '#' separators and bad variants are rejected.
  for (const bad of [' /model', '/ ', '  /  ', 'prov/  ', '  /mod', 'a/b#x#y', 'a/b#', 'a/b# x', 'a /b', 'a/ b', 'a/b#x#y#z']) {
    assert.equal(parseModelRef(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseModelRef('a/b#x'), { providerID: 'a', id: 'b', variant: 'x' });
  // Object form: empty/whitespace parts and non-string variants rejected.
  assert.equal(parseModelRef({ providerID: ' ', id: 'b' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: ' ' }), null);
  assert.equal(parseModelRef({ providerID: '  a', id: 'b' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: 1 }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: {} }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: ' ' }), null);
  assert.deepEqual(parseModelRef({ providerID: 'a', id: 'b', variant: null }), { providerID: 'a', id: 'b' });
  // String and object forms parse to the same ref, namespaced ids included.
  for (const str of ['a/b', 'prov/vendor/model', 'a/b#x', 'prov/vendor/sub/model#high']) {
    const slash = str.indexOf('/');
    const hash = str.indexOf('#');
    const head = hash === -1 ? str : str.slice(0, hash);
    const obj = hash === -1
      ? { providerID: head.slice(0, slash), id: head.slice(slash + 1) }
      : { providerID: head.slice(0, slash), id: head.slice(slash + 1), variant: str.slice(hash + 1) };
    const fromStr = parseModelRef(str);
    assert.deepEqual(fromStr, obj, `string form ${JSON.stringify(str)}`);
    assert.deepEqual(parseModelRef(obj), fromStr, `object form must equal string form for ${JSON.stringify(str)}`);
  }
  // Namespaced (inner "/") model ids are valid in both forms...
  assert.deepEqual(parseModelRef('openrouter/meta-llama/llama-3#low'), {
    providerID: 'openrouter', id: 'meta-llama/llama-3', variant: 'low',
  });
  assert.deepEqual(parseModelRef({ providerID: 'openrouter', id: 'meta-llama/llama-3' }), {
    providerID: 'openrouter', id: 'meta-llama/llama-3',
  });
  // ...but "/" in providerID is not.
  assert.equal(parseModelRef({ providerID: 'a/b', id: 'c' }), null);
  // Object form rejects whitespace verbatim instead of trimming it silently.
  assert.equal(parseModelRef({ providerID: 'a', id: 'b c' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b ' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: ' b' }), null);
  assert.equal(parseModelRef({ providerID: 'a ', id: 'b' }), null);
  assert.equal(parseModelRef({ providerID: 'a b', id: 'b' }), null);
  assert.equal(parseModelRef({ providerID: 'a#b', id: 'b' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b#c' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: ' x' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: 'x ' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: '' }), null);
  assert.equal(parseModelRef({ providerID: 'a', id: 'b', variant: 'x#y' }), null);
  assert.deepEqual(parseModelRef({ providerID: 'a', id: 'b', variant: undefined }), { providerID: 'a', id: 'b' });
  const expected = parseModelRef('opencode/big-pickle');
  assert.equal(modelRefMatches(expected, { providerID: 'opencode', id: 'big-pickle' }), true);
  assert.equal(modelRefMatches(expected, { providerID: 'opencode', id: 'big-pickle', variant: 'x' }), true,
    'unexpected variant on the actual side is not a mismatch');
  assert.equal(modelRefMatches(expected, { providerID: 'other', id: 'big-pickle' }), false);
  assert.equal(modelRefMatches(parseModelRef('opencode/big-pickle#high'), { providerID: 'opencode', id: 'big-pickle' }), false);
  assert.equal(describeModelRef(expected), 'opencode/big-pickle');
  assert.equal(describeModelRef(null), null);
});
