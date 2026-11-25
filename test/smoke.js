// End-to-end test against a running bridge server: submit a real task through
// submit_task -> get_task_status -> get_task_result and verify the executor
// actually used tools (non-empty toolCalls) and produced a result.
//
// Usage: node test/smoke.js [token]
// The token may instead come from BRIDGE_SMOKE_TOKEN (keeps it out of the
// process list). The URL defaults to http://127.0.0.1:9999/mcp and can be
// overridden with BRIDGE_SMOKE_URL. The bridge server must already be running.
// The token is never printed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.argv[2] || process.env.BRIDGE_SMOKE_TOKEN;
if (!token) {
  console.error('usage: node test/smoke.js [token]');
  console.error('  token also accepted via BRIDGE_SMOKE_TOKEN; URL via BRIDGE_SMOKE_URL');
  process.exit(2);
}

const TERMINAL = ['completed', 'partial', 'failed', 'cancelled', 'blocked'];
const url = process.env.BRIDGE_SMOKE_URL || 'http://127.0.0.1:9999/mcp';
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

function textOf(res) {
  return (res.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function main() {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));

  const prompt = [
    'Perform these steps and report each result verbatim:',
    '1. Read the file test/e2e-fixture.txt and report its exact contents.',
    '2. Run the shell command `echo e2e-shell-ok`.',
    '3. Create a file test/e2e-out.txt containing exactly "e2e-write-ok", read it back, and report its contents.',
    'End with a one-line summary: DONE <step1-result> <step2-result> <step3-result>.',
  ].join('\n');

  const submit = await client.callTool({ name: 'submit_task', arguments: { prompt } });
  const submitText = textOf(submit);
  console.log('submit_task:', submitText);
  const submitJson = JSON.parse(submitText);
  if (submit.isError || !submitJson.taskID) {
    console.error('submit_task did not return a taskID');
    process.exit(1);
  }
  const taskID = submitJson.taskID;

  // Poll status until terminal (or timeout).
  const deadline = Date.now() + 180_000;
  let status = null;
  let statusJson = null;
  while (Date.now() < deadline) {
    const s = await client.callTool({ name: 'get_task_status', arguments: { taskID } });
    statusJson = JSON.parse(textOf(s));
    status = statusJson.status;
    console.log('status:', status, statusJson.outcome ?? '');
    if (TERMINAL.includes(status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const result = await client.callTool({ name: 'get_task_result', arguments: { taskID } });
  const resultJson = JSON.parse(textOf(result));
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(resultJson, null, 2));

  const toolCalls = resultJson.toolCalls ?? [];
  console.log('\n=== TOOL CALLS ===');
  for (const tc of toolCalls) console.log(`  ${tc.name} (${tc.status})`);

  const failures = [];
  const resultStatus = resultJson.status;
  // The executor must actually reach a usable terminal state. `completed` means
  // every step succeeded cleanly; `partial` means the goal was reached but a
  // step errored (recovered) or the result was truncated — both prove real tool
  // usage, so either is acceptable for this smoke test.
  if (!['completed', 'partial'].includes(resultStatus)) {
    failures.push(`expected result status completed|partial, got ${resultStatus}`);
  }
  if (toolCalls.length === 0) failures.push('expected non-empty toolCalls, got []');
  if (typeof resultJson.result !== 'string' || resultJson.result.trim() === '') {
    failures.push('expected a non-empty result text');
  }

  if (failures.length > 0) {
    console.error('\nSMOKE FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }

  console.log('\nSMOKE OK');
  await client.close();
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
