# QA Contract

## Spec (frozen intent)

- Created by `/qa preflight` as revision 1: `mattspi.qa.spec.v1`.
- Any change creates revision N+1 with `supersedes: <id>#r<N>`. The original
  intent is never silently rewritten after implementation.
- Minimum: task (raw + normalised), ≥1 acceptance item (`A1…`), project
  (repo_root, branch, base_sha), revision.

## Verdicts

| Verdict            | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `PASS`             | acceptance satisfied with adequate evidence                                      |
| `PASS_WITH_NOTES`  | satisfied + meaningful non-blocking observations                                 |
| `FAIL`             | concrete unmet requirement or defect                                             |
| `INCONCLUSIVE`     | required evidence unavailable/insufficient — never converted to pass or fail     |
| `STOP_RECOMMENDED` | continuing crosses a consequential boundary; recommends only, authorises nothing |

Determination order: stop reasons → violated → unverified/not_checked →
notes → pass. `REPORTED`-only evidence on an important requirement is
downgraded to `unverified` (→ `INCONCLUSIVE`).

## Integrity (separate axis)

`OK` (ordinary defect) · `SUSPECT` (environment altered) ·
`COMPROMISED` (QA rules tampered / verification defeated).

## Trusted rules (§11)

Policy comes from the **base ref**, never the branch under review. If the
branch changed `AGENTS.md` / `package.json` / `.pi/qa/policy.md`, that is a
`qa-rules-changed` signal requiring explicit review — the verifier judges by
the baseline.

## Independence (§12)

- Verifier = fresh `pi --mode json -p --no-session` process.
- Input: frozen spec, trusted rules, snapshot, diff, test/reuse evidence,
  Lantern pack. **No builder narrative.**
- Builder claims classified `SUPPORTED / UNSUPPORTED / CONTRADICTED /
NOT_CHECKED` only after the initial verdict.
- The pipeline proves the boundary at runtime: building a verifier prompt
  with a builder report throws.

## Review depth

`LIGHT` (docs/trivia) · `STANDARD` (ordinary features, default) ·
`DEEP` (auth, security, persistence, concurrency, migrations, authority,
irreversible state). Selected by consequential seams; recorded on the spec.

## Degradation (§28)

| Missing        | Behaviour                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Lantern        | continue; Lantern evidence `UNAVAILABLE`; never invent memory                                  |
| Telltail       | continue; behavioural evidence `UNAVAILABLE`                                                   |
| Reusery        | local checks continue; external search **not** claimed                                         |
| GitHub/remote  | local verify continues; remote check `UNAVAILABLE`; `INCONCLUSIVE`/`FAIL` if push was required |
| Model verifier | deterministic evidence preserved; semantic verdict `INCONCLUSIVE`                              |
