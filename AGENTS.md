# AGENTS.md

Operating rules for anyone (human or AI agent) working in this repository.

This repository is the **publication copy** of a local OpenCode MCP bridge.
It is prepared for publication; it has not been built, installed, run or
tested as part of its preparation. Do not claim otherwise in docs or commits.

## Project map

```
src/
  main.js           entry point: token, Store, Executor, HTTP server, watchdog, signals
  config.js         all configuration + env overrides (single source of defaults)
  server.js         Streamable HTTP MCP server, session map, Bearer auth gate, arg validation
  auth.js           creates/loads random Bearer token (0600), constant-time verify
  executor.js       task lifecycle: one active task slot, state machine, result budget
  opencode-api.js   wrapper around `opencode api` subprocess + error classification
  store.js          SQLite (node:sqlite) persistence of tasks
test/
  mock.test.js      isolated unit tests (FakeApi, temp DB) - no real opencode
  http.test.js      in-process HTTP/MCP lifecycle test - no real opencode
  smoke.js          MANUAL end-to-end check against an already-running server
deploy/
  opencode-mcp-bridge.service  systemd unit (loopback-only, User=opencode)
  install-autostart.sh         root-only installer for the unit
executor-config.example.json   EXAMPLE of a locked-down executor agent (not applied)
run_tests.sh                   runs mock.test.js + http.test.js via node --test
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
- Do not run install/build/test, the project code, or the deployment scripts
  as part of a documentation/publication change unless explicitly requested.
  This environment has no separate VPS: do not use sudo, do not touch systemd
  services, and do not modify a running instance.
- Do not change global Git config or GitHub settings.
- Do not perform `git add`, `git commit` or `git push` unless explicitly
  requested; leave the tree for review.

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
  the bridge for a dedicated service user. The unit hard-codes
  `WorkingDirectory`, `User=opencode`, `PATH` (including the `opencode` CLI)
  and `ExecStart=/usr/bin/node src/main.js`; only the network-online target and
  ordering after `opencode.service` are expressed via `After=`/`Wants=`.
  `deploy/install-autostart.sh` must be run as root and stops a manually
  started `node src/main.js` first.
- Configuration is read from the process environment (`BRIDGE_*`, see
  `src/config.js` and `.env.example`). Nothing loads `.env` automatically;
  set variables in the shell (`set -a; . ./.env; set +a`) or in the unit
  (`Environment=` / `EnvironmentFile=`).
- Never copy local runtime state (token, DB, logs) between the two.
