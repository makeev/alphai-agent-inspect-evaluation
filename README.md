# AlphAI AgentInspect evaluation

Local evaluation of the published `agent-inspect@6.29.1` and
`@agent-inspect/mcp@6.29.1` packages, September 14, 2026.
The MCP transport dependency is `@modelcontextprotocol/sdk@1.30.0`.

The flow under test is a synthetic client of the public AlphAI MCP server
([mcp.alphai.io](https://alphai.io/mcp), an AI financial news feed): one
`alphai_ticker_news` read, a 429 carrying `retry_after_seconds` and the limiting
window, a wait, and one retry. Nothing here reaches AlphAI or any other network
service; the transport is the real MCP SDK with an injected synthetic fetch.

## Run

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Dependencies are already installed in the original evaluation directory.
Node 24.14.1 was used for the full evaluation. The minimal packaging reproduction
was also verified on Node 26.7.0, with both ESM and CommonJS imports.

The tests use no API keys, LLM, network server, or production data.
The full fixture uses the real MCP SDK with an injected synthetic fetch.
The application owns its retry loop. Waits advance a virtual clock; displayed
wall-clock trace durations do **not** represent those virtual waits.

`npm test` exits zero when the documented results are reproduced, including
known defects. Messages saying `step() called outside inspectRun()` are expected
from the stock MCP adapter and are part of the reproduction.

## Files

- `minimal-mcp-repro.mjs`: smallest packaging test. Two MCP calls execute but
  zero MCP steps are captured. A direct core step in the same run is captured.
- `evaluate.mjs`: four scenarios through three capture paths (12 runs).
- `make-reports.mjs`: CLI checks, HTML reports, and an Evidence bundle with
  an integrity verification.
- `latest-run.json`: points to the latest complete evaluation run.
- `runs/<timestamp>/summary.json`: assertions, transport observations, and checks.
- `runs/<timestamp>/reports/`: HTML reports, five CLI results, verified bundle.

## What the fixture demonstrates

The rate-limit fixture independently models admission for `cur=18`, `prev=2`,
`seconds_into=1`, `limit=20`. The next request is admitted after 29 seconds.
It represents a historical AlphAI bug, not the current production behavior.

| Scenario | Server hint / client wait | Expected observation |
| --- | --- | --- |
| bad-server | 2s / 2s | Client complies; isolated admission promise fails |
| bad-client | 29s / 2s | Client violates hint; server promise is not evaluated |
| fixed | 29s / 29s | Second call succeeds |
| tool-isError | HTTP 200, MCP `isError: true` | Normal read did not succeed |

Capture paths:

1. `stock`: published `wrapMcpClient`. Missing tool steps reproduce a bundled
   context split. Required-tool checks catch the absence.
2. `manual-unlinked`: core `step()` records actual calls, with summaries only.
   A retry cap cannot group attempts without identity; a resolved `isError`
   result needs a business outcome. These are capture limitations, not proof
   that every generic function tracer should throw on a returned object.
3. `enriched`: core tracing plus explicit transport facts, operation/attempt
   identity, measured virtual delay, and business outcomes. A local bridge copies
   recorded `attributes.metadata.arguments` to `attributes.arguments` for
   structured checks. Original traces remain untouched.

The delay and admission oracles are implemented in this fixture and recorded via
`observeOutcome`. AgentInspect displays/gates their outcomes; it does not discover
the limiter equation or implement a built-in Retry-After timing oracle.

The fixed run passes. Wrong server/client behavior and MCP failure produce failed
outcomes. CLI exit codes are checked: fixed = 0; other three = 1. A stock fixed run
also exits 1 under `--required-tool` because capture is missing.

This is an isolated minute-limit test. Real production concurrency, daily quotas,
transport limits, and requests from other clients must be accounted for before
attributing a repeated 429 to a server defect.

## Upstream references

- [MCP client wrapper](https://github.com/rajudandigam/agent-inspect/blob/main/packages/mcp/src/wrap.ts)
- [MCP build config](https://github.com/rajudandigam/agent-inspect/blob/main/tsup.mcp.config.ts)
- [Trace contracts](https://github.com/rajudandigam/agent-inspect/blob/main/docs/TRACE-CONTRACTS.md)
- [MCP roles](https://github.com/rajudandigam/agent-inspect/blob/main/docs/MCP-ROLES.md)

The installed MCP bundle contains its own `AsyncLocalStorage` and `stepImpl`.
The application core package uses another instance, explaining the capture gap
even though `npm ls agent-inspect` reports one deduplicated dependency.

No upstream package was patched, and no production configuration or service code
was changed.

## Upstream status

Reported to the maintainer on September 14, 2026 and confirmed against the
shipped artifact. Upstream issues opened September 16, 2026:

- [#413](https://github.com/rajudandigam/agent-inspect/issues/413): the published
  wrapper bundles a second runtime and loses `inspectRun` context.
- [#414](https://github.com/rajudandigam/agent-inspect/issues/414): structured
  manual arguments are unreachable by tool-argument checks.
- [#415](https://github.com/rajudandigam/agent-inspect/issues/415): manual
  instrumentation drops a thrown error's numeric code.
- [#420](https://github.com/rajudandigam/agent-inspect/issues/420): `wrapMcpClient`
  spreads the SDK client, so prototype methods are dropped and private state is
  shallow-copied. Filed from this fixture; it survives any fix to #413.

The assertions in this repository encode 6.29.1 behavior on purpose, so it stays
a usable failing baseline. When a fixed release lands, test it in a separate
directory rather than editing these expectations in place.
