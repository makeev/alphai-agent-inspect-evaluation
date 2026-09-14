import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Runs only in memory. Tested against the actual npm artifacts, not monorepo source.
const require = createRequire(import.meta.url);
const base = join(process.cwd(), 'repro-runs', `${process.version}-${Date.now()}`);
const results = [];
for (const mode of ['esm', 'cjs']) {
  const { inspectRun, step } = mode === 'esm' ? await import('agent-inspect') : require('agent-inspect');
  const { wrapMcpClient } = mode === 'esm' ? await import('@agent-inspect/mcp') : require('@agent-inspect/mcp');
  const traceDir = join(base, mode);
  await mkdir(traceDir, { recursive: true });
  let actualCalls = 0;
  const client = wrapMcpClient({
    listTools: async () => { actualCalls++; return { tools: [] }; },
    callTool: async () => { actualCalls++; return { content: [], isError: false }; },
  });
  await inspectRun('published-mcp-capture', async () => {
    await step('core-control', async () => true, { type: 'tool' });
    await client.listTools();
    await client.callTool({ name: 'alphai_ticker_news', arguments: { ticker: 'AAPL' } });
  }, { traceDir, silent: true });
  const file = (await readdir(traceDir)).find(name => name.endsWith('.jsonl'));
  const lines = (await readFile(join(traceDir, file), 'utf8')).trim().split('\n').map(JSON.parse);
  const started = lines.filter(event => event.event === 'step_started');
  const result = { mode, node: process.version, actualMcpCalls: actualCalls,
    coreControlSteps: started.filter(event => event.name === 'core-control').length,
    capturedMcpSteps: started.filter(event => event.name.startsWith('mcp:')).length };
  assert.equal(result.actualMcpCalls, 2);
  assert.equal(result.coreControlSteps, 1);
  assert.equal(result.capturedMcpSteps, 0, 'This assertion reproduces the 6.29.1 defect; change it after an upstream fix.');
  results.push(result);
}
await writeFile(join(base, 'summary.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ base, results }, null, 2));
