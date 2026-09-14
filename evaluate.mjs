import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRun, step, observeOutcome } from 'agent-inspect';
import { wrapMcpClient } from '@agent-inspect/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readTrace } from 'agent-inspect/readers';
import { defineTraceContract, evaluateTraceContract, buildTraceFacts } from 'agent-inspect/checks';

// Real MCP SDK, synthetic fetch: no sockets, keys, LLM, or production calls.
// The application owns retry policy; neither SDK nor AgentInspect adds this loop.
// Virtual time affects only the fake limiter and injected wait, never Date.now().
const base = join(process.cwd(), 'runs', new Date().toISOString().replaceAll(':', '-'));
await mkdir(base, { recursive: true });
const toolName = 'alphai_ticker_news';
const args = { ticker: 'AAPL', page_size: 5 };
const reports = [];
const checks = {
  runOnly: { run: { requireCompleted: true, allowedStatuses: ['ok'] } },
  path: { run: { requireCompleted: true, allowedStatuses: ['ok'] }, tools: { required: [toolName], forbidden: ['alphai_alerts_subscribe'] } },
  retryLimit: { run: { allowedStatuses: ['ok', 'error'] }, retry: { maxAttempts: 2 } },
  arguments: { run: { allowedStatuses: ['ok', 'error'] }, tools: { arguments: [{ tool: toolName, path: '/ticker', operator: 'equals', expected: 'AAPL', occurrence: 'all' }] } },
  outcome: { observations: { required: ['business-result'], failOn: ['failed'] } },
};

for (const capture of ['stock', 'manual-unlinked', 'enriched']) {
  for (const scenario of ['bad-server', 'bad-client', 'fixed', 'tool-isError']) {
    const name = `${capture}-${scenario}`;
    const dir = join(base, name);
    const wire = [];
    const caught = [];
    let now = 0;
    let latestResponse;
    let finalResult;
    let finalError;
    let requestNumber = 0;
    let attempt = 0;
    const record = async (eventName, expectation, status, actual) => {
      if (capture === 'enriched') await observeOutcome(eventName, { expectation, status, method: 'custom', actual });
    };
    const syntheticFetch = async (_url, init) => {
      assert.equal(new URL(_url).hostname, 'alphai-fixture.invalid');
      if (init.method === 'GET') return new Response(null, { status: 405 });
      const message = JSON.parse(init.body);
      const id = `request-${++requestNumber}`;
      const fact = { id, method: message.method, jsonRpcId: message.id ?? null, atMs: now, statusCode: 200 };
      let result;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'AlphAI synthetic fixture', version: '0' } };
      } else if (message.method === 'notifications/initialized') {
        fact.statusCode = 202;
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: toolName, inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, page_size: { type: 'integer' } }, required: ['ticker'] } }] };
      } else if (message.method === 'tools/call') {
        fact.attempt = attempt;
        if (scenario === 'tool-isError') {
          result = { content: [{ type: 'text', text: 'Synthetic tool failure' }], isError: true };
        } else {
          // Independent admission model for the historical cur=18, prev=2,
          // s=1, Free limit=20 case: capacity first returns after 29 seconds.
          const weighted = 19 + 2 * (1 - (1 + now / 1000) / 60);
          if (weighted > 20) {
            fact.statusCode = 429;
            fact.retryAfterSeconds = scenario === 'bad-server' ? 2 : Math.ceil(29 - now / 1000);
            fact.window = 'minute';
          } else {
            result = { content: [{ type: 'text', text: '{"items":[],"next_cursor":null}' }], isError: false };
          }
        }
        latestResponse = fact;
      } else throw new Error(`Unexpected method: ${message.method}`);
      wire.push(fact);
      await record('transport-response', 'Record allowlisted transport facts', 'passed', fact);
      if (fact.statusCode === 202) return new Response(null, { status: 202 });
      if (fact.statusCode === 429) return Response.json({
        error: 'rate_limit_exceeded', window: 'minute', limit: 20,
        retry_after_seconds: fact.retryAfterSeconds, tier: 'free',
      }, { status: 429, headers: { 'Retry-After': String(fact.retryAfterSeconds) } });
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    };
    const client = new Client({ name: 'alphai-agent-inspect-evaluation', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://alphai-fixture.invalid/mcp'), { fetch: syntheticFetch });
    const wrapped = wrapMcpClient(client, { serverName: 'alphai-fixture', sessionId: name });
    await inspectRun(name, async () => {
      try {
        await client.connect(transport);
        if (capture === 'stock') await wrapped.listTools();
        else await step('mcp:tools/list', () => client.listTools(), { type: 'tool', metadata: { toolName: 'tools/list' } });
        for (attempt = 1; attempt <= 3; attempt++) {
          const previousResponse = latestResponse;
          try {
            finalResult = capture === 'stock'
              ? await wrapped.callTool({ name: toolName, arguments: args })
              : await step(`mcp:${toolName}`, () => client.callTool({ name: toolName, arguments: args }), {
                type: 'tool', metadata: capture === 'manual-unlinked' ? { toolName, argumentSummary: JSON.stringify(args) } : {
                  toolName, arguments: args, operationId: `${name}-operation`,
                  attemptNumber: attempt, attemptId: `${name}-attempt-${attempt}`,
                  ...(attempt > 1 ? { retryOf: `${name}-attempt-${attempt - 1}` } : {}),
                },
              });
            if (previousResponse?.statusCode === 429) {
              const waitedMs = latestResponse.atMs - previousResponse.atMs;
              await record('retry-after-admission', 'An isolated minute-limit retry after the advertised delay is admitted',
                waitedMs >= previousResponse.retryAfterSeconds * 1000 ? 'passed' : 'skipped',
                { previousRequestId: previousResponse.id, requestId: latestResponse.id, waitedMs, statusCode: latestResponse.statusCode });
            }
            await record('business-result', 'A normal read returns a non-error MCP result', finalResult.isError ? 'failed' : 'passed', { isError: finalResult.isError === true });
            break;
          } catch (error) {
            caught.push({ name: error.name, code: error.code, hasRetryAfter: 'retryAfter' in error, hasHeaders: 'headers' in error });
            if (previousResponse?.statusCode === 429) {
              const waitedMs = latestResponse.atMs - previousResponse.atMs;
              await record('retry-after-admission', 'An isolated minute-limit retry after the advertised delay is admitted',
                waitedMs >= previousResponse.retryAfterSeconds * 1000 ? 'failed' : 'skipped',
                { previousRequestId: previousResponse.id, requestId: latestResponse.id, waitedMs, statusCode: latestResponse.statusCode });
            }
            if (error.code !== 429 || attempt === 3) {
              await record('business-result', 'A normal read eventually succeeds', 'failed', { errorCode: error.code });
              throw error;
            }
            const advertisedMs = latestResponse.retryAfterSeconds * 1000;
            const waitMs = scenario === 'bad-client' ? 2000 : advertisedMs;
            const before = now;
            now += waitMs; // Injected virtual wait, deterministic and instant.
            await record('retry-delay', 'The client waits at least the advertised Retry-After', waitMs >= advertisedMs ? 'passed' : 'failed', {
              responseId: latestResponse.id, advertisedMs, actualWaitMs: now - before, delaySource: 'retry-after', clock: 'virtual',
            });
          }
        }
      } finally { await client.close(); }
    }, { traceDir: dir, silent: true }).catch(error => { finalError = error.message; });
    const file = (await readdir(dir)).find(f => f.endsWith('.jsonl'));
    const tracePath = join(dir, file);
    const originalRead = await readTrace({ type: 'file', path: tracePath });
    const read = capture !== 'enriched' ? originalRead : await readTrace({
      type: 'string', content: originalRead.events.map(event => JSON.stringify({
        ...event,
        attributes: { ...event.attributes,
          // Explicit local bridge: legacy step(metadata.arguments) becomes
          // attributes.metadata.arguments; contract readers expect attributes.arguments.
          ...(event.attributes?.metadata?.arguments ? { arguments: event.attributes.metadata.arguments } : {}),
        },
      })).join('\n'),
    });
    if (capture === 'enriched') await writeFile(join(dir, 'contract-input.jsonl'), read.events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const facts = buildTraceFacts(read.events);
    const results = {};
    for (const [key, contract] of Object.entries(checks)) {
      const result = evaluateTraceContract({ read }, defineTraceContract(contract));
      results[key] = { ok: result.ok, status: result.status, findings: result.findings.map(f => ({ ruleId: f.ruleId, status: f.status, message: f.message })) };
    }
    const report = {
      name, tracePath, runId: read.runs[0].runId, wire, caught,
      nodeVersion: process.version,
      argumentsBeforeBridge: evaluateTraceContract({ read: originalRead }, defineTraceContract(checks.arguments)).ok,
      wrapperHasClose: typeof wrapped.close === 'function',
      returnedIsError: finalResult?.isError, endedInException: !!finalError,
      outcomes: read.events.filter(e => e.kind === 'OUTCOME').map(e => ({ name: e.name, status: e.attributes?.outcomeStatus, actual: e.attributes?.actual })),
      toolEvents: facts.logicalEvents?.filter(e => e.kind === 'TOOL').map(e => ({ name: e.name, status: e.status, error: e.error, attributes: e.attributes })),
      results,
    };
    await writeFile(join(dir, 'wire.json'), JSON.stringify(wire, null, 2));
    await writeFile(join(dir, 'checks.json'), JSON.stringify(report, null, 2));
    reports.push(report);
  }
}
const get = name => reports.find(r => r.name === name);
assert.equal(get('stock-tool-isError').returnedIsError, true);
assert.equal(get('stock-tool-isError').results.runOnly.ok, true, 'Run-only check cannot see a missing tool outcome');
assert.equal(get('stock-fixed').toolEvents.length, 0, 'Reproduce published wrapper context split');
assert.equal(get('stock-fixed').results.path.ok, false, 'Required-tool check correctly detects missing capture');
assert.equal(get('manual-unlinked-tool-isError').results.path.ok, true, 'Resolved MCP isError result needs an explicit outcome');
assert.equal(get('manual-unlinked-bad-server').results.retryLimit.ok, true, 'Retry cap needs explicit operation linkage');
assert.equal(get('enriched-bad-server').results.retryLimit.ok, false);
assert.equal(get('enriched-fixed').argumentsBeforeBridge, false);
assert.equal(get('stock-fixed').results.arguments.ok, false, 'Stock argumentSummary does not supply structured evidence');
assert.equal(get('enriched-fixed').results.arguments.ok, true);
assert.equal(get('enriched-fixed').results.outcome.ok, true);
assert.equal(get('enriched-tool-isError').results.outcome.ok, false);
assert.equal(get('enriched-bad-server').results.outcome.ok, false);
assert.equal(get('enriched-bad-client').results.outcome.ok, false);
const outcomes = (name, outcome) => get(name).outcomes.filter(o => o.name === outcome);
assert.deepEqual(outcomes('enriched-bad-server', 'retry-delay').map(o => o.status), ['passed', 'passed']);
assert.deepEqual(outcomes('enriched-bad-server', 'retry-after-admission').map(o => o.status), ['failed', 'failed']);
assert.deepEqual(outcomes('enriched-bad-client', 'retry-delay').map(o => o.status), ['failed', 'failed']);
assert.deepEqual(outcomes('enriched-bad-client', 'retry-after-admission').map(o => o.status), ['skipped', 'skipped']);
assert.equal(get('enriched-fixed').wire.filter(w => w.method === 'tools/call')[1].atMs, 29000);
await writeFile(join(base, 'summary.json'), JSON.stringify(reports, null, 2));
await writeFile('latest-run.json', JSON.stringify({ base }, null, 2));
console.log(JSON.stringify({ base, results: reports.map(r => ({
  name: r.name, calls: r.wire.filter(w => w.method === 'tools/call').length,
  path: r.results.path.ok, retryLimit: r.results.retryLimit.ok,
  arguments: r.results.arguments.ok, outcome: r.results.outcome.ok,
})) }, null, 2));
