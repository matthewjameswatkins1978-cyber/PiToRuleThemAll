# Architecture

Pi To Rule Them All is the **conductor, not another orchestra**. It adds
evidence-based QA, reuse checks and institutional-memory integration to Pi
without forking Pi or duplicating Lantern Keeper, Telltail, Reusery or
Tethers.

```
Pi (runtime: agent, models, sessions, MCP, tools)
│
├── Pi To Rule Them All (this repo — a Pi package)
│    ├── qa/          preflight → verify → receipt (core, Pi-free)
│    ├── evidence/    git snapshot, bounded commands, test runs
│    ├── reuse/       rg → ast-grep → clones → Lantern → Reusery
│    ├── adapters/    lantern / telltail / reusery / tethers
│    └── extensions/pi-qa  thin Pi adapter (commands + keeper_* tools)
│
├── Lantern Keeper   memory, provenance, context, decisions (via MCP)
├── Telltail         behavioural/evaluator verification (invoked, not copied)
├── Reusery          deep reuse discovery when justified (gated, not per-change)
└── Tethers          authority and consequential STOP decisions
```

## Separation of responsibilities

| Owner          | Owns                                                          | This repo must not                            |
| -------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Pi             | runtime, models, sessions, MCP, tools                         | fork or patch core                            |
| Lantern Keeper | Sources/Episodes/Claims/Beliefs, Context Packs, provenance    | create another memory DB                      |
| Pi QA (here)   | frozen intent, evidence, reuse inspection, verdicts, receipts | silently acquire authority                    |
| Telltail       | behavioural evidence, checking the checker                    | be rebuilt inside                             |
| Reusery        | deep reuse discovery, contracts                               | be invoked for tiny changes                   |
| Tethers        | actual authority decisions                                    | be bypassed; QA emits `STOP_RECOMMENDED` only |

## Adapter boundary (§33)

Core logic (`src/`) is testable without starting Pi. All Pi-specific API
usage lives in `extensions/pi-qa/` behind `src/pi-shim.ts` (structural,
buildable without Pi installed). A Pi upgrade should require at most a
thin shim change.

Each integration has one real transport adapter, composed once at the
Pi boundary by `IntegrationRegistry` (`src/adapters/registry.ts`) and
injected into core QA — no null callers scattered through user code:

| Integration | Transport                                                                | Notes                                                                        |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Lantern     | stdio MCP (`lighting mcp` bridge, spec JSON-RPC)                         | needs local service on 127.0.0.1:4317                                        |
| Reusery     | stdio MCP (`reusery mcp` bridge)                                         | needs `REUSERY_DATABASE_URL`; consults only through the proportionality gate |
| Telltail    | CLI (`telltail`, else `go run` in its module)                            | deterministic evaluator, never a per-review LLM call                         |
| Tethers     | CLI (`tethers describe`; `check/preview/plan` only with explicit config) | read-only; QA never authorises                                               |

Design constraint (verified against Pi 0.99.2 types): command handlers
cannot invoke nested tools, so `/qa` and `/keeper` reach Lantern/Reusery
through the systems' own documented stdio bridges (same contract as
Pi's MCP), while the model-callable `keeper_*` tools use native
`ctx.executeTool`. No model round-trip is spent on deterministic work;
no MCP framing is invented beyond the stdio transport both servers
document. Each adapter degrades to an explicit state (`NOT_CONFIGURED
/ UNREACHABLE / TOOL_MISSING / OPERATION_FAILED / DISABLED_BY_POLICY
/ NOT_NEEDED`) instead of inventing results.

## Data flow

```
/qa preflight  →  snapshot git → trusted rules@base → lantern pack? →
                   reuse resolve → depth → spec r1 (.pi/qa/specs/)
/qa verify     →  freeze reality → spec → trusted rules@base →
                   evidence (tests EXECUTED) → reuse → lantern pack →
                   detectors → fresh pi --no-session verifier (no builder
                   narrative) → telltail? → classify builder claims →
                   receipt (.pi/qa/receipts/)
/qa receipt    →  compact human view (default) or --json machine form
/keeper        →  status / handoff to keeper_context|keeper_why live tools
```

## Context economy (§26)

- Bounded Context Packs (ids + summaries + provenance pointers), never full memory dumps.
- Verifier bundle caps diffs at 40k chars with truncation flags.
- Command output caps (32 KiB/stream); receipts store metadata + exit codes, not streams.
- Deterministic checks run outside the model; the model judges, it doesn't grep.

## Dependency decisions (§34, §10)

- No runtime dependencies. Node builtins (fs, crypto, child_process) suffice.
- No ajv: two small stable schemas get a ~120-line explicit validator.
- No jscpd: bounded normalised-block clone search covers QA's needs; see
  `src/reuse/clone-search.ts` for the recorded decision.
- Dev-only: typescript, prettier, typebox (Pi's mandated schema language for tools).
