import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeApi, OpenCodeError } from '../src/opencode-api.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('setModel rejects malformed values without echo or subprocess', async () => {
  let calls = 0;
  const api = createOpencodeApi({ spawnFn: () => { calls++; throw new Error('must not spawn'); } });
  const sentinel = 'SECRET_SENTINEL_NOT_A_REAL_CREDENTIAL';
  for (const value of [sentinel, `provider/${sentinel}#`, { providerID: sentinel, id: '' }]) {
    await assert.rejects(() => api.setModel('ses_test', value, 1000), (e) => {
      assert.ok(e instanceof OpenCodeError);
      assert.equal(e.httpStatus, 400);
      assert.equal(e.message.includes(sentinel), false);
      assert.match(e.message, /invalid model reference/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('startup refuses missing or malformed model before creating runtime files', () => {
  for (const model of [undefined, '', '   ', 'SECRET_SENTINEL_NOT_A_MODEL']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridge-startup-'));
    try {
      const env = { ...process.env,
        BRIDGE_TOKEN_FILE: path.join(dir, 'token'),
        BRIDGE_DB_PATH: path.join(dir, 'tasks.db'),
        BRIDGE_LOG_FILE: path.join(dir, 'bridge.log'),
      };
      delete env.NODE_OPTIONS;
      delete env.NODE_V8_COVERAGE;
      delete env.BRIDGE_EXECUTOR_MODEL;
      if (model !== undefined) env.BRIDGE_EXECUTOR_MODEL = model;
      const result = spawnSync(process.execPath, ['src/main.js'], {
        cwd: root, env, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /configuration error:.*BRIDGE_EXECUTOR_MODEL/);
      assert.equal(result.stderr.includes('SECRET_SENTINEL'), false);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
