# AGENTS.md

Operating rules for anyone (human or AI agent) working in this repository.

This repository is the **publication copy** of a local OpenCode MCP bridge.
It has an isolated test suite (`npm test`, driven by `scripts/test-isolated.js`,
eight test files) and CI (`.github/workflows/diagnostics-isolated-test.yml`).

## Project map

```
src/
  main.js              entry point: token, Store, Executor, HTTP server, watchdog, signals
  config.js            all configuration + env overrides (single source of defaults)
  server.js            Streamable HTTP MCP server, session map, Bearer auth gate, arg validation
  auth.js              creates/loads random Bearer token (0600), constant-time verify
  executor.js          task lifecycle: one active task slot, state machine, result budget
  opencode-api.js      wrapper around `opencode api` subprocess + error classification
  store.js             SQLite (node:sqlite) persistence of tasks
  sanitize.js          best-effort secret redaction and diagnostic length limits
  tool-diagnostics.js  builds bounded, redacted diagnostics for failed tool calls
test/
  mock.test.js                 isolated unit tests (FakeApi, temp DB) - no real opencode
  http.test.js                 in-process HTTP/MCP lifecycle test - no real opencode
  api-compat.test.js           config.js/opencode-api.js compat: error classification, model, loopback warning
  executor-integration.test.js executor lifecycle integration tests (isolated)
  hardening.test.js            bad/missing model rejected without echo, no files created
  tool-error-diagnostics.test.js  failed tool-call diagnostics tests
  sanitize-regression.test.js  secret-redaction regression tests
  tool-diagnostics-unit.test.js   unit tests for diagnostic formatting
  smoke.js                     MANUAL end-to-end check against an already-running server
scripts/
  test-isolated.js     runs the eight isolated test files (`npm test`)
deploy/
  opencode-mcp-bridge.service  systemd unit template (loopback-only; examples for user/paths)
  install-autostart.sh         root-only installer for the unit
.github/workflows/
  diagnostics-isolated-test.yml  CI job running the isolated test suite
executor-config.example.json   EXAMPLE of a locked-down executor agent (not applied)
run_tests.sh                   runs scripts/test-isolated.js
package-lock.json              locked dependency tree
AGENTS.md                      this file
.env.example                   documented env variables (NOT auto-loaded)
```

Runtime flow: MCP client -> Streamable HTTP (`http://HOST:PORT`) -> bridge ->
subprocess `opencode api ...` -> an OpenCode executor agent/session.

## Rules of work

- **Never change executable code, defaults or working settings** while
  preparing publication. Fixes to code belong in a separate, reviewed change.
- Keep documentation faithful to the code. If code and docs disagree, report
  the discrepancy instead of inventing behavior.
- Do not add a license unless the repository owner explicitly asks for one.
- `npm test` is allowed and expected: it runs the isolated suite from
  `scripts/test-isolated.js` (no live bridge or OpenCode instance needed).
  Do not run installs or builds unless explicitly requested.
- Do not run smoke checks against a live bridge without the owner's permission.
- Read the scripts in `deploy/` and the systemd unit before running them; do not
  run deploy scripts without review.
- Do not change global Git config, GitHub settings, a running bridge instance or
  systemd services without explicit permission.
- Do not perform `git add`, `git commit` or `git push` unless the owner
  explicitly asks; otherwise leave the tree for review.

## Secrets policy (hard rule)

Never commit or copy into this repository:

- `.bearer_token` (the bridge's own token), or any token/session file;
- SQLite databases (`*.db`) and their sidecars (`-wal`, `-shm`, `-journal`);
- logs (`*.log`), `backups/`, `node_modules/`;
- `.env` or any real local config/environment file;
- API keys, private SSH keys, cookies, or personal data of any kind.

Only `.env.example` (names + safe sample values) is allowed. When reviewing a
change, verify the file list, not just the diff text. Never print secret
values while checking; report only file paths and line numbers.

## Development vs. deployment (keep separate)

- **Development**: run the bridge locally from a checkout, on loopback, with
  your own `.bearer_token` and database, so you can iterate safely.
- **Deployment**: a systemd unit (`deploy/opencode-mcp-bridge.service`) runs
  the bridge for a dedicated service user. The unit ships example values for
  `WorkingDirectory` (`/opt/opencode-mcp-bridge`), `User`/`Group`, `HOME` and
  `PATH` (the directory with the `opencode` CLI must be added), and uses
  `ExecStart=/usr/bin/node src/main.js`; only the network-online target and
  ordering after `opencode.service` are expressed via `After=`/`Wants=`.
  `deploy/install-autostart.sh` must be run as root, copies the unit as-is
  (edit it first) and stops a manually started `node src/main.js` first.
- Configuration is read from the process environment (`BRIDGE_*`, see
  `src/config.js` and `.env.example`). Nothing loads `.env` automatically;
  set variables in the shell (`set -a; . ./.env; set +a`) or in the unit
  (`Environment=` / `EnvironmentFile=`).
- Never copy local runtime state (token, DB, logs) between the two.
