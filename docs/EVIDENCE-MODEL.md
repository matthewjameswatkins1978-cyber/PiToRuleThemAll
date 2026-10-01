# Evidence Model

Every important QA assertion carries one evidence grade:

| Grade         | Meaning                                          | Example                            |
| ------------- | ------------------------------------------------ | ---------------------------------- |
| `EXECUTED`    | QA itself ran it and captured the result         | `npm test` exit 0                  |
| `OBSERVED`    | QA directly inspected state/artifact             | `package.json` gains no dependency |
| `REPORTED`    | another actor claims it; QA did not observe      | "builder says tests pass"          |
| `INFERRED`    | reasoning from evidence, visibly marked          | style                              |
| `UNAVAILABLE` | could not be obtained → may force `INCONCLUSIVE` | Lantern offline                    |

## Rules

1. `REPORTED` alone rarely justifies important `PASS` claims — the pipeline
   downgrades such checks to `unverified`.
2. Receipts store **bounded evidence or references**: command + exit code +
   truncation flag; file paths + observations; never secrets, never full
   streams (32 KiB cap per stream, diff cap 40k chars).
3. Receipts may record provider identity, tool used, credential source class
   — never credential material. A secret-shaped match fails closed (metadata
   only).
4. Behaviour over shape (§13): persistence-class requirements need
   write → destroy → restart → read → compare probes, not unit-test
   shape. See `restartProbe` and `agents/verifier.md`.
5. Reuse reports `searched / found / not_checked` in search order
   (§9): same file → module → repo → siblings → Lantern → native →
   installed dependency → Reusery → new implementation.
