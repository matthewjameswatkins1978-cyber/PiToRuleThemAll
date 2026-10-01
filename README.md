# Pi To Rule Them All

Matthew's personal engineering layer for Pi. It adds evidence-based QA, reuse
checks and institutional-memory integration **without forking Pi or
duplicating Lantern Keeper, Telltail, Reusery or Tethers**.

Principle: **Coder does. Evidence records what happened. Lantern remembers
why. QA independently checks whether it was right. Telltail checks the
checker. Reusery asks whether we needed to build it at all. Tethers decides
what may happen. Matthew remains the authority.**

## Install

One-time install as a Pi package (local path — no manual file copying):

```bash
pi install ./PiToRuleThemAll
```

Update after pulling:

```bash
pi update --extensions
```

Or try for one invocation without installing:

```bash
pi -e ./PiToRuleThemAll
```

Requires: Pi ≥ 0.99, `git`, `rg` (ast-grep optional but recommended for
structural reuse search).

## Commands

| Command                                                                                                         | Purpose                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/qa preflight <request>`                                                                                       | Freeze intent → QA spec revision 1, reuse scan, depth. No PASS/FAIL.        |
| `/qa verify [specId] [--report "path"] [--claim-tests] [--require-push] [--telltail] [--reusery] [--spec-only]` | Independent verification → machine-readable receipt.                        |
| `/qa receipt [id] [--json]`                                                                                     | Compact receipt (default) or full JSON.                                     |
| `/qa doctor [--smoke]`                                                                                          | Integration diagnostics.                                                    |
| `/keeper [status \| context <q> \| why <id>]`                                                                   | One-action Lantern memory/provenance. Honest UNAVAILABLE when disconnected. |

Model-callable live Lantern tools (in-session): `keeper_context`, `keeper_why`.

`/qa preflight` accepts sections after the raw request:

```
/qa preflight Add restart-safe config persistence.
Acceptance:
- A1: value written is readable after process restart
- A2: corrupted file yields a clear error, never a crash
Seams: persistence
```

## Receipt semantics

`PASS / PASS_WITH_NOTES / FAIL / INCONCLUSIVE / STOP_RECOMMENDED`, with
integrity `OK / SUSPECT / COMPROMISED` on a separate axis. `INCONCLUSIVE`
means evidence was missing — it is never success or failure.
`STOP_RECOMMENDED` recommends only; **Tethers remains the authority
boundary** and QA authorises nothing.

Evidence grades: `EXECUTED` (QA ran it) · `OBSERVED` (QA inspected it) ·
`REPORTED` (someone claims it) · `INFERRED` (reasoned, marked) ·
`UNAVAILABLE` (missing). `REPORTED`-only evidence cannot carry an important
`PASS`.

## How independent verification works

`/qa verify` spawns a **fresh `pi --mode json -p --no-session` process**
that receives the frozen spec, trusted baseline rules, snapshot, diff and
evidence — never the builder's narrative. Only after its initial verdict
are builder claims classified `SUPPORTED / UNSUPPORTED / CONTRADICTED /
NOT_CHECKED`. Trusted policy comes from the git base ref, so a branch that
rewrites QA rules cannot grade itself by them.

## What is deterministic vs AI

Deterministic (no model): git snapshot, trusted-rule load, test execution,
rg/ast-grep/clone search, detectors, verdict arithmetic, receipt validation.
AI (isolated verifier): judging the frozen spec against the evidence.

## Failure modes

Lantern/Telltail/Reusery/remote/model missing → QA continues with that
evidence `UNAVAILABLE` (→ `INCONCLUSIVE` where the missing piece was
required). Nothing is invented; see `docs/QA-CONTRACT.md`.

## Development

```bash
npm install
npm run check       # format:check + typecheck + deterministic tests
npm run check:live  # + opt-in live integrations (Lantern service, model)
```

Ordinary `npm run check` never makes model calls and needs no network.
Live integrations are explicit (`PI_QA_LIVE_LANTERN=1`, `/qa doctor
--smoke`, `/qa verify --telltail`).

No GitHub Actions: for this private single-maintainer repo, local
deterministic gates plus live dogfood give the independent value; hosted
CI would only re-run what `npm run check` already proves. Revisit if a
second platform ever matters.

## Environment

| Variable               | Purpose                                          | Default                                      |
| ---------------------- | ------------------------------------------------ | -------------------------------------------- |
| `PI_QA_LANTERN_BIN`    | Lantern bridge binary                            | `<lantern-keeper>/target/debug/lighting.exe` |
| `PI_QA_LANTERN_URL`    | Lantern service URL                              | `http://127.0.0.1:4317`                      |
| `PI_QA_REUSERY_BIN`    | Reusery bridge binary                            | `~/.pi/agent/bin/reusery.exe`                |
| `REUSERY_DATABASE_URL` | Reusery Postgres (secret: env only, never files) | _none_                                       |
| `TELLTAIL_REPO`        | Telltail checkout for `go run` fallback          | `D:\Projects\Telltail`                       |
| `PI_QA_LIVE_LANTERN`   | enable the live M0 test                          | unset (skipped)                              |

Pi MCP: Lantern is configured in `~/.pi/agent/mcp-adapter.json`
(the adapter owns MCP sessions; Pi's legacy `mcp.json` is left alone so
servers never double-start). `/qa` and `/keeper` additionally reach
Lantern through the registry's own stdio bridge sessions.

See `docs/M0-CONNECTIVITY.md`, `docs/ARCHITECTURE.md`, `docs/EVIDENCE-MODEL.md`.
