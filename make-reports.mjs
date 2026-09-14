import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { base } = JSON.parse(await readFile('latest-run.json', 'utf8'));
const runs = JSON.parse(await readFile(join(base, 'summary.json'), 'utf8'));
const cli = join(process.cwd(), 'node_modules/agent-inspect/packages/cli/dist/index.cjs');
const out = join(base, 'reports');
await mkdir(out, { recursive: true });
const executions = [];
function invoke(args, expectedStatus) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, `${args[0]}: ${result.stderr}\n${result.stdout}`);
  executions.push({ args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  return result;
}
for (const name of ['stock-fixed', 'enriched-bad-server', 'enriched-bad-client', 'enriched-fixed', 'enriched-tool-isError']) {
  const run = runs.find(r => r.name === name);
  const dir = dirname(run.tracePath);
  // Original recorded trace is sufficient for outcome/presence checks; the
  // argument bridge is used separately by evaluate.mjs for structured assertions.
  const result = invoke(['check', run.tracePath, '--required-tool', 'alphai_ticker_news', '--fail-on-observation', 'failed', '--json'], name === 'enriched-fixed' ? 0 : 1);
  await writeFile(join(out, `${name}-cli-check.json`), result.stdout);
  invoke(['report', run.runId, '--dir', dir, '--format', 'html', '--section', 'all', '--include-attributes', '--out', join(out, `${name}.html`)], 0);
}
const good = runs.find(r => r.name === 'enriched-fixed');
const bundlePath = join(out, 'fixed-evidence');
invoke(['bundle', good.runId, '--dir', dirname(good.tracePath), '--profile', 'share', '--out', bundlePath], 0);
invoke(['bundle', 'verify', bundlePath], 0);
await writeFile(join(out, 'cli-executions.json'), JSON.stringify(executions, null, 2));
console.log(JSON.stringify({ out, checkExitCodes: executions.filter(e => e.args[0] === 'check').map(e => ({ trace: e.args[1], exitCode: e.exitCode })), bundleVerified: true }, null, 2));
