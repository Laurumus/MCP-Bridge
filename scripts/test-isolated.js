import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'test/mock.test.js',
  'test/http.test.js',
  'test/api-compat.test.js',
  'test/executor-integration.test.js',
  'test/hardening.test.js',
];
const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (child.error) {
  console.error('Unable to start isolated test runner:', child.error.code);
}
process.exit(child.status ?? 1);
