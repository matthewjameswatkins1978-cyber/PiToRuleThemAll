# AGENTS.md — Pi To Rule Them All

**Coder does. QA independently verifies.** Do not trust completion reports as
evidence. Inspect real repository state.

## Working in this repo

- Small, bounded changes. This project is the conductor, not the orchestra:
  do not reimplement Pi, Lantern Keeper, Telltail, Reusery or Tethers here.
- Reuse order before new code: same file → module → repo → siblings →
  Lantern history → native capability → installed dependency → Reusery →
  new implementation. Report searched / found / not_checked.
- Prefer existing runtime capability and mature libraries. No new database,
  daemon or service. No dependency without a recorded §34 justification.
- Core (`src/`) must stay testable without Pi. Pi-specific code lives in
  `extensions/pi-qa/` behind `src/pi-shim.ts`.
- Never claim an unrun test passed. `REPORTED` is not `EXECUTED`.
- Never put secrets in receipts, memory, fixtures, commits or logs.
- Finished repository work is pushed unless explicitly local-only.

## QA workflow (dogfood it)

1. `/qa preflight` before implementing: freeze intent, record depth.
2. Implement with reuse search first.
3. `/qa verify` after: independent reviewer, receipt stored.
4. Commit with meaningful bounded messages; push normal history only
   (never force-push, never rewrite published history).

## Checks

```bash
npm run typecheck
npm run test
```

Formatting: prettier (`npm run format:check`). All three must pass before
a commit is pushed.
