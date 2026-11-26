# OpenCode MCP Bridge

A local MCP server (Streamable HTTP) for delegating tasks to OpenCode.
Built on Node.js (`>=22.5`, the built-in `node:sqlite` is required) with the
official SDK `@modelcontextprotocol/sdk` (v1.32.x). It listens on a loopback
address by default (override with BRIDGE_HOST) and calls `opencode api` through
a subprocess (no shell).

```
MCP client → this server (127.0.0.1:9999, Bearer token)
           → subprocess `opencode api ...` → OpenCode agent/session
```

> Status: the server and its configuration are documented from the actual code.
> The isolated test suite (`npm test`) passes in CI; the end-to-end check
> (`test/smoke.js`) was run manually against a local bridge; compatibility
> with specific external MCP clients has not been verified.

## Structure

- `src/config.js` — all constants and their `BRIDGE_*` env overrides
- `src/opencode-api.js` — `opencode api` wrapper + error classification
  (ambiguous / definite outcome)
- `src/store.js` — SQLite task store (`node:sqlite`)
- `src/executor.js` — task lifecycle, single active slot, watchdog,
  recovery, executor-agent readiness check
- `src/auth.js` — random Bearer token (0600 file) + constant-time comparison
- `src/server.js` — Streamable HTTP MCP server with a multi-session
  lifecycle, argument validation and safe error codes
- `src/tool-diagnostics.js` — tool call summaries (`name`, `status`,
  optional `error`/`callID`) and the result budget
- `src/sanitize.js` — best-effort secret redaction in diagnostic text
- `src/main.js` — entry point
- `test/mock.test.js` — isolated mock tests (FakeApi, temporary DB, the real
  `opencode` is not called)
- `test/http.test.js` — in-process HTTP/MCP lifecycle test, the real
  `opencode` is not called
- `test/api-compat.test.js` — compatibility with `opencode api` response shapes
- `test/executor-integration.test.js` — Executor lifecycle without a real
  `opencode`
- `test/hardening.test.js` — hardening / safe-rejection checks
- `test/tool-error-diagnostics.test.js` — tool call error diagnostics in
  `get_task_result`
- `test/sanitize-regression.test.js` — secret redaction regressions
- `test/tool-diagnostics-unit.test.js` — unit tests for error normalization
  and the budget
- `test/smoke.js` — manual end-to-end check against a **running** server
- `executor-config.example.json` — an **example** configuration of a
  restricted executor agent (not applied)
- `deploy/opencode-mcp-bridge.service` — systemd unit
- `deploy/install-autostart.sh` — unit installer (root only)
- `scripts/test-isolated.js` — a single explicit list of isolated tests
- `run_tests.sh` — a shell wrapper for the same run as `npm test`
- `.env.example` — list of supported environment variables (not loaded
  automatically)

## Installation and running (development)

```bash
npm install
BRIDGE_EXECUTOR_MODEL=apmix/deepseek-v4.1-flash-1017 npm start
# Example model: pick one available in your OpenCode configuration.
# Listens on http://127.0.0.1:9999 by default.
```

Stop with `Ctrl+C` / `SIGTERM`. `npm start` = `node src/main.js`.

On first start the following are created next to the project:
- `.bearer_token` — a random token (mode 0600), if the file does not exist yet;
- `tasks.db` — the SQLite task database;
- `bridge.log` — the log.

All three paths can be overridden (`BRIDGE_TOKEN_FILE`, `BRIDGE_DB_PATH`,
`BRIDGE_LOG_FILE`). These files are local and must not be committed to the
repository (see `.gitignore`).

## Configuration and environment variables

All variables are read from `process.env` in `src/config.js`; the full list
with defaults is in [`.env.example`](.env.example). The main ones:

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | listen address |
| `BRIDGE_PORT` | `9999` | port |
| `BRIDGE_DB_PATH` | `<repo>/tasks.db` | task database |
| `BRIDGE_TOKEN_FILE` | `<repo>/.bearer_token` | Bearer token file |
| `BRIDGE_LOG_FILE` | `<repo>/bridge.log` | log |
| `BRIDGE_EXECUTOR_AGENT` | `executor` | OpenCode agent name |
| `BRIDGE_EXECUTOR_MODEL` | none, required | model `provider/model`, optionally `#variant`; the OpenCode model is not inherited |
| `BRIDGE_WORKDIR` | `<repo>` | absolute session directory passed as `location.directory`; not the CLI `cwd` |
| `BRIDGE_OPENCODE_API_TIMEOUT_MS` | `30000` | timeout of a single call |
| `BRIDGE_TASK_EXECUTION_TIMEOUT_MS` | `300000` | task timeout |
| `BRIDGE_WATCHDOG_INTERVAL_MS` | `3000` | watchdog period |
| `BRIDGE_MAX_PROMPT_LENGTH` | `10000` | max prompt length |
| `BRIDGE_MAX_RESULT_LENGTH` | `50000` | max result size |
| `BRIDGE_MAX_REQUEST_BODY_SIZE` | `1048576` | max HTTP request body size |
| `BRIDGE_MAX_SESSIONS` | `100` | max MCP sessions |

Numeric values that are `<= 0` or not numeric are replaced with the default.

If `BRIDGE_HOST` is not a loopback address (`127.0.0.1`, `::1`, `localhost`),
a warning with the host name is printed at startup: the bridge gives access to
tool execution via a Bearer token, so the traffic and the token must be
protected (TLS, reverse proxy, firewall). Startup is not blocked; on loopback
there is no extra output.

**How to pass the environment.** The server does **not load `.env`
automatically** (the project has no dotenv). Options:

```bash
# 1) shell: export the variables before starting
set -a; . ./.env; set +a; node src/main.js

# 2) systemd: Environment= / EnvironmentFile= in the unit
```

`.env.example` is only documentation of the variables; a copy named `.env` is
not committed to the repository.

## Authorization

Every request (GET/POST/DELETE) requires the header
`Authorization: Bearer <token>`, otherwise `401` is returned. The token is
created once in `.bearer_token` (mode 0600), is unrelated to OpenCode/other
service tokens and is not logged.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `submit_task` | `{ prompt }` | `{ taskID, status }` |
| `get_task_status` | `{ taskID }` | `{ taskID, status, outcome, error, cost, tokens }` |
| `get_task_result` | `{ taskID, cursor? }` | `{ taskID, status, result, toolCalls, outcome, error, hasMore, cursor, truncated, cost, tokens }` |
| `cancel_task` | `{ taskID }` | `{ taskID, cancelled, status }` |

The client cannot pass: agent/model, sessionID, an arbitrary API path, shell
commands, a project path, permissions. The agent, model and working directory
are set locally (`BRIDGE_EXECUTOR_AGENT`, `BRIDGE_EXECUTOR_MODEL`,
`BRIDGE_WORKDIR`). `inputSchema` is described for `tools/list`; arguments are
validated explicitly in code.

### Tool call diagnostics (`get_task_result`)

`toolCalls` is an array of summaries collected by the bridge from assistant
messages: `{ name, status }` are always present (`null` if the source part has
no such field). Only with `status: "error"` can the following appear:

- `error` — a string from `state.error`/`state.detail` (preferring the fields
  `message`, `name`, `data`; getters and `toJSON` are not called, cycles are
  marked `[circular]`). Secrets are redacted first, then control characters
  are replaced with spaces and the text is truncated. The result is limited to
  the first 300 characters (`…` is appended on truncation); text that is empty
  after cleaning is omitted.
- `callID` — the call identifier is taken from `part.callID`, then
  `part.toolCallID`, then `state.callID`, and in real OpenCode data from the
  part's own `id` (the last fallback), and only if it is a string of
  `[A-Za-z0-9_.:-]` of length 1..128. Best-effort behavior: otherwise the
  field is absent and is not synthesized.

`input`, `output`, `args` and other tool part fields are **not exported** in
the response. Only the text of assistant messages goes into `result`;
reasoning is excluded.

Error extraction is limited to depth 3 and a budget of 20 visited nodes; a
node string value longer than 16384 characters is replaced with
`[diagnostic omitted: oversized error]…`, and the collected text longer than
16384 characters is replaced entirely with `[REDACTED] oversized diagnostic`.
Redaction is best-effort and pattern-based (headers, `api_key`, `password`,
`token`, Bearer, `sk-`, GitHub, AWS, Slack): it does **not guarantee** that
arbitrary text is free of secrets.

Budget: `result.length + JSON.stringify(toolCalls).length` must not exceed
`BRIDGE_MAX_RESULT_LENGTH` (50000 by default); this is not the size of the
full MCP envelope. When exceeded, `truncated: true` is set, the result text is
truncated and gets `[TRUNCATED]`; when selecting, calls with status `error`
are prioritized (in the original order), long `error` values may be
truncated, and some summaries may be dropped. `truncated` relates only to the
budget, not to `cursor`/`hasMore` pagination. There is no separate counter of
the number of errors.

The `partial` status is set when OpenCode reported success (outcome is not
`failed`/`interrupted` and not empty), but the result was truncated by the
budget or the retained `toolCalls` contain a call with `status: "error"`;
such a task is not considered fully successful.
A failed tool call is possible even when the task outcome is successful: for
example, if the model passed an unknown argument name, OpenCode rejects the
call, and the error text may show empty arguments.

## Multi-session Streamable HTTP

One process serves several MCP clients: each `initialize` creates a separate
transport + session, routing is done by `mcp-session-id`, and
`DELETE`/closing the transport removes the session. All sessions share **one
Executor** and a shared "one active task" limit. Disconnecting an MCP client
closes only its transport and does **not cancel** the OpenCode task.

## Errors

Only safe codes are returned to the client (`INVALID_ARGUMENT`,
`PROMPT_TOO_LONG`, `EXECUTOR_UNAVAILABLE`, `EXECUTOR_CHECK_FAILED`,
`AGENT_MISMATCH`, `MODEL_MISMATCH`, `SETUP_FAILED`, `NOT_FOUND`, `TASK_BUSY`,
`PROMPT_REJECTED`, `SESSION_CREATE_AMBIGUOUS`, `SESSION_CREATE_FAILED`,
`RESULT_UNAVAILABLE`, `STATUS_UNAVAILABLE`, `BAD_CONFIG`, `BAD_RESPONSE`, …)
without raw messages. Details are written only to the local log
(`bridge.log`), in sanitized form.

## Task statuses

- `submitting` — the session is being created, the prompt is being sent
- `pending` — the prompt was sent, execution is in progress
- `unknown` — ambiguous outcome of sending/interrupting (the slot is held,
  the next submit is blocked)
- `completed` — OpenCode finished successfully, the result was delivered in
  full
- `partial` — OpenCode finished successfully, but the result was truncated by
  the budget or one of the tool calls ended with an error (the goal is not
  considered fully achieved)
- `failed` — OpenCode finished with an error
- `cancelled` — interrupted
- `blocked` — the task was not started, there is no result
- `error` — confirmed rejection before start (the slot is released)

## Lightweight executor agent (example, optional)

**Any** OpenCode agent suitable as `primary` is compatible with the bridge.
`executor-config.example.json` shows how to set up a **restricted** `executor`
agent: file reading only, no writing, no shell, no MCP and no subagents (final
rule `deny`). This is a separate, optional scenario.

If such a restricted agent is running (its rules end with a deny-all), the
readiness check at startup detects the mode as `restricted` ("deny-all,
text-only") — the agent is suitable as `primary`, but cannot run
shell/write/MCP tools.

**This is not the default working agent.** The bridge does not require a
restricted agent: like any other OpenCode agent, the executor can have the
full set of tools (file writing, shell, dev tools, MCP servers). The readiness
check on **every** submit (`verifyExecutorReady`, no persistent cache) only
confirms that the agent exists and can act as `primary`; the actual mode
(`full` / `restricted`) is written to the log at startup.

Each task gets a **separate OpenCode session**: context is not kept between
tasks. Recursion protection: if an MCP server exposing the bridge's own tools
(`submit_task`/`get_task_status`/`get_task_result`/`cancel_task`) appears in
the environment, you must not delegate your work through them — the task has
to be done with your own tools.

## Autostart (systemd)

The repository contains a systemd unit: `deploy/opencode-mcp-bridge.service`
(`Type=exec`, `Restart=on-failure`, `After=opencode.service` — start order
only, the unit does not guarantee OpenCode API readiness). The unit contains
example values: `WorkingDirectory=/opt/opencode-mcp-bridge`, the service user
`opencode`, `HOME` and `PATH`; adapt them to your installation.

The installer `deploy/install-autostart.sh` determines the bridge directory
from its own location and copies the unit as is, so edit `User`,
`WorkingDirectory`, `PATH` (and `EnvironmentFile` if needed) in the unit
before running it:

```bash
sudo bash deploy/install-autostart.sh
```

The script requires root: it installs the unit into `/etc/systemd/system`,
runs `systemctl daemon-reload` and `systemd-analyze verify`, stops a manually
started `node src/main.js` from the bridge directory (exact match: owner
`opencode`, cwd = bridge directory), checks that the port is free, then
enables and starts the service. If the manual process did not stop or the
port is busy, it aborts without starting a second instance. Read the script
before running it.

The manual process lookup assumes the owner `opencode`; for a different
service user, edit the owner check in the script (without a match the script
simply will not find a manual bridge and will check whether the port is busy).

The environment in the unit is set via `Environment=` (`HOME`, `PATH` — add
the directory of the `opencode` CLI, `NODE_NO_WARNINGS`). Additional `BRIDGE_*`
variables can be added to the unit via `Environment=`/`EnvironmentFile=`; the
unit does not read `.env` itself.

The template includes a mandatory
`EnvironmentFile=/etc/opencode-mcp-bridge/bridge.env`. Before starting, the
administrator must create this file (recommended mode 0600) with an explicit
`BRIDGE_EXECUTOR_MODEL=apmix/deepseek-v4.1-flash-1017`, replacing the example
with an available model. In a systemd file use `NAME=value` lines, without
`export`. Check User, Group, WorkingDirectory and PATH for your installation.

## Tests

```bash
npm test                                    # isolated tests only
./run_tests.sh                              # the same list
BRIDGE_SMOKE_TOKEN="$(cat .bearer_token)" npm run test:smoke # separately, against a live server
```

`npm test` and `run_tests.sh` run one explicit list of eight files:
`mock.test.js`, `http.test.js`, `api-compat.test.js`,
`executor-integration.test.js`, `hardening.test.js`,
`tool-error-diagnostics.test.js`, `sanitize-regression.test.js`,
`tool-diagnostics-unit.test.js`. The real `opencode` is not called; HTTP tests
may open a local port. Smoke is not in this list and may create a real task
and modify files. `test/smoke.js` is a manual check against an already
running server: the URL comes from `BRIDGE_SMOKE_URL` (default
`http://127.0.0.1:9999/mcp`), the token from the first argument, or, if it is
absent, from `BRIDGE_SMOKE_TOKEN` (so the secret does not show up in the
process list). It creates a real task, calls the model, polls the status,
checks the result and the presence of tool calls; the token is not printed.
It expects the file `test/e2e-fixture.txt` relative to the working directory
of the executor session (this fixture is not included in the repository).

## Limitations

- The bridge requests the session directory through `location.directory` from
  `BRIDGE_WORKDIR`, but does not verify the actual directory by reading it
  back. The CLI is started with the `cwd` of the bridge process; this is
  separate from the session directory. Start the bridge from a trusted
  directory.
- Compatibility with specific external MCP clients has not been verified.

## License

MIT — see [LICENSE](LICENSE).
