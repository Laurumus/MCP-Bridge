import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolError, summarizeToolPart, enforceResultBudget } from '../src/tool-diagnostics.js';

test('normalization: preferred-field cycles terminate', () => {
  for (const field of ['message', 'name', 'data']) {
    const error = {};
    error[field] = error;
    assert.match(describeToolError({ error }), /circular/);
  }
});

test('normalization: accessors and toJSON are never invoked', () => {
  let reads = 0;
  const error = { code: 'EACCES', toJSON() { throw new Error('must not run'); } };
  Object.defineProperty(error, 'message', { enumerable: true, get() { reads++; throw new Error('must not run'); } });
  assert.match(describeToolError({ error }), /EACCES/);
  assert.equal(reads, 0);
});

test('normalization: hostile proxy traps are contained', () => {
  const error = new Proxy({}, {
    ownKeys() { throw new Error('unavailable'); },
    getOwnPropertyDescriptor() { throw new Error('unavailable'); },
  });
  assert.equal(describeToolError({ error }), null);
});

test('normalization: preferred fields obey depth limits', () => {
  let error = { message: 'unreachable' };
  for (let i = 0; i < 50; i++) error = { message: error };
  assert.equal(describeToolError({ error }), null);
});

test('normalization: empty entries consume the visit budget', () => {
  const error = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, null]));
  error.last = 'must-not-be-visited';
  assert.equal(describeToolError({ error }), null);
});

test('normalization: primitive and object errors, no raw input or output', () => {
  assert.equal(describeToolError({ error: { message: 'invalid path' } }), 'invalid path');
  assert.equal(describeToolError({ error: null }), null);
  const part = { name: 'write', callID: 'call_1', state: {
    status: 'error', error: 'EACCES', input: 'fake-private-input', output: 'fake-private-output',
  } };
  assert.deepEqual(summarizeToolPart(part), { name: 'write', status: 'error', error: 'EACCES', callID: 'call_1' });
});

test('callID: real OpenCode part shape uses the top-level id and leaks no input', () => {
  const part = {
    type: 'tool', id: 'prt_realistic123', name: 'read', executed: true,
    state: {
      status: 'error',
      input: { file_path: '/x/y' },
      error: { type: 'tool.execution', message: 'Invalid arguments for tool "read": - path: Missing key' },
    },
    time: {},
  };
  const entry = summarizeToolPart(part);
  assert.equal(entry.callID, 'prt_realistic123');
  assert.equal(entry.name, 'read');
  assert.equal(entry.status, 'error');
  assert.match(entry.error, /Invalid arguments for tool "read"/);
  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('/x/y'), false, 'input path must not be exported');
  assert.equal(serialized.includes('file_path'), false, 'input keys must not be exported');
});

test('callID: explicit callID wins over a top-level id', () => {
  const part = { type: 'tool', id: 'prt_realistic123', name: 'read', callID: 'call_explicit_1',
    state: { status: 'error', error: 'boom' } };
  assert.equal(summarizeToolPart(part).callID, 'call_explicit_1');
});

test('callID: an id with invalid characters does not produce the field', () => {
  const part = { type: 'tool', id: 'prt/realistic 123', name: 'read',
    state: { status: 'error', error: 'boom' } };
  assert.equal('callID' in summarizeToolPart(part), false);
});

test('callID: a successful part with an id gets no callID', () => {
  const part = { type: 'tool', id: 'prt_realistic123', name: 'read',
    state: { status: 'completed', input: { file_path: '/x/y' } } };
  assert.deepEqual(summarizeToolPart(part), { name: 'read', status: 'completed' });
});

test('budget: preserve a failed call when a successful history is too large', () => {
  const calls = Array.from({ length: 100 }, () => ({ name: 'read', status: 'completed' }));
  calls.push({ name: 'write', status: 'error', error: 'EACCES: permission denied' });
  const out = enforceResultBudget('x'.repeat(1000), calls, 180);
  assert.ok(out.truncated);
  assert.ok(out.toolCalls.some((call) => call.error?.includes('EACCES')));
  assert.ok(out.result.length + JSON.stringify(out.toolCalls).length <= 180);
});

test('budget: shrink long errors and retain original relative order', () => {
  const calls = [
    { name: 'read', status: 'completed' },
    { name: 'write', status: 'error', callID: 'call_1', error: 'EACCES ' + 'x'.repeat(300) },
  ];
  const original = JSON.stringify(calls);
  const out = enforceResultBudget('', calls, 130);
  assert.ok(out.toolCalls.some((call) => call.error?.startsWith('EACCES')));
  assert.ok(out.result.length + JSON.stringify(out.toolCalls).length <= 130);
  assert.equal(JSON.stringify(calls), original);
});

test('budget: exact fit is not truncated and tiny budgets stay bounded', () => {
  const calls = [{ name: 'read', status: 'completed' }];
  const max = 3 + JSON.stringify(calls).length;
  assert.deepEqual(enforceResultBudget('abc', calls, max), { result: 'abc', toolCalls: calls, truncated: false });
  for (const budget of [2, 3, 12, 20, 100]) {
    const out = enforceResultBudget('x'.repeat(200), calls, budget);
    assert.ok(out.result.length + JSON.stringify(out.toolCalls).length <= budget);
  }
});
