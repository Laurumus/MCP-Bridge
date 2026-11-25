import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { BridgeError } from './executor.js';

/**
 * The four tools. Input schemas are documentation for tools/list; they are NOT
 * relied on for validation (the low-level Server does not enforce them), so
 * every argument is validated explicitly in `validateArgs`.
 */
const TOOLS = [
  {
    name: 'submit_task',
    description: 'Submit one task to the OpenCode executor. Returns a taskID.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'The task prompt' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_status',
    description: 'Get the status and outcome of a task submitted by this bridge.',
    inputSchema: {
      type: 'object',
      properties: { taskID: { type: 'string', description: 'Task identifier returned by submit_task' } },
      required: ['taskID'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_result',
    description: 'Get the result of a task, with optional pagination cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        taskID: { type: 'string', description: 'Task identifier returned by submit_task' },
        cursor: { type: 'string', description: 'Opaque pagination cursor (optional)' },
      },
      required: ['taskID'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a running task. The underlying session is never deleted.',
    inputSchema: {
      type: 'object',
      properties: { taskID: { type: 'string', description: 'Task identifier returned by submit_task' } },
      required: ['taskID'],
      additionalProperties: false,
    },
  },
];

function isString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Explicit argument validation (inputSchema alone is not enforcement). */
function validateArgs(name, args) {
  const arg = args ?? {};
  switch (name) {
    case 'submit_task':
      if (!isString(arg.prompt)) return 'INVALID_ARGUMENT';
      return null;
    case 'get_task_status':
    case 'cancel_task':
      if (!isString(arg.taskID)) return 'INVALID_ARGUMENT';
      return null;
    case 'get_task_result':
      if (!isString(arg.taskID)) return 'INVALID_ARGUMENT';
      if (arg.cursor !== undefined && !isString(arg.cursor)) return 'INVALID_ARGUMENT';
      return null;
    default:
      return 'UNKNOWN_TOOL';
  }
}

/** Safe, client-facing error code. Raw messages never leave the process. */
function errorCode(e) {
  if (e && typeof e.code === 'string' && e.code) return e.code;
  return 'INTERNAL_ERROR';
}

function textResult(json, isError = false) {
  const result = { content: [{ type: 'text', text: JSON.stringify(json) }] };
  if (isError) result.isError = true;
  return result;
}

function sanitizeForLog(value) {
  const s = String(value && (value.stack || value.message) ? (value.stack || value.message) : value);
  // strip control chars (newlines etc.) and cap length so the local log stays tidy
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000);
}

/**
 * Build one MCP Server instance. A fresh instance is created per MCP session
 * (transport), but every instance shares the same `executor`, so the single
 * active-task limit is enforced across all sessions.
 */
export function buildServer(executor, log = () => {}) {
  const server = new Server(
    { name: 'opencode-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const arg = args ?? {};

    const invalid = validateArgs(name, arg);
    if (invalid) {
      return textResult({ code: invalid }, true);
    }

    try {
      switch (name) {
        case 'submit_task': {
          const res = await executor.submitTask(arg.prompt);
          return textResult(res);
        }
        case 'get_task_status': {
          const status = await executor.getStatus(arg.taskID);
          return textResult(status);
        }
        case 'get_task_result': {
          const result = await executor.getResult(arg.taskID, arg.cursor ?? undefined);
          return textResult(result);
        }
        case 'cancel_task': {
          const res = await executor.cancelTask(arg.taskID);
          return textResult(res);
        }
        default:
          return textResult({ code: 'UNKNOWN_TOOL' }, true);
      }
    } catch (e) {
      log(`tool ${name} failed: ${sanitizeForLog(e)}`);
      return textResult({ code: errorCode(e) }, true);
    }
  });

  return server;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BridgeError('request body too large', 'INVALID_ARGUMENT'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new BridgeError('invalid JSON body', 'INVALID_ARGUMENT'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * Start the Streamable HTTP MCP server, bound to the configured host/port,
 * guarded by the bridge's Bearer token on every request.
 *
 * Session lifecycle (per the official SDK examples):
 * - a POST with no `mcp-session-id` whose body is an `initialize` request
 *   creates a new transport + server, registered under a generated session id;
 * - subsequent GET/POST/DELETE are routed by `mcp-session-id`;
 * - DELETE (or transport close) removes the session from the map.
 *
 * All sessions share the single `executor`, so the one-active-task limit is
 * global. Disconnecting an MCP client only closes its transport; it never
 * cancels an OpenCode task.
 */
export async function startServer({ executor, auth, config, log = () => {} }) {
  const sessions = new Map(); // sessionId -> { transport }

  const httpServer = http.createServer((req, res) => {
    if (!auth.verify(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Bearer',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    handleMcpRequest(req, res).catch((err) => {
      log(`mcp request error: ${sanitizeForLog(err)}`);
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    });
  });

  async function handleMcpRequest(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    const method = req.method;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(req, config.maxRequestBodySize);
      if (isInitializeRequest(body)) {
        if (sessions.size >= config.maxSessions) {
          sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions' }, id: null });
          return;
        }
        const server = buildServer(executor, log);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          maxRequestBodySize: config.maxRequestBodySize,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.get(sid)?.transport === transport) {
            sessions.delete(sid);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session id provided' },
        id: null,
      });
      return;
    }

    // GET / DELETE without a session id
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing session id' },
      id: null,
    });
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : config.port;

  async function close() {
    for (const { transport } of sessions.values()) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    sessions.clear();
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { httpServer, sessions, close, port: actualPort };
}
