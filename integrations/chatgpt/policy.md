# ChatGPT-side Lantern access policy (M6, read-first)

## Allowed by default

- `lantern_status` — service health, version.
- `lantern_search` — bounded (`limit: 10`).
- `lantern_context` — bounded (`item_budget: 8`, `token_budget: 2000`).
- `lantern_why` — provenance for a known id (`memory_id` preferred).

Every result keeps its identity: id, summary, provenance pointer.
Never flatten decision text into anonymous strings.

## Explicit intent only

- `lantern_remember` — only when Matthew says so, e.g. "Lucy, record
  this decision", "Remember this in Lantern", "Store this as a rejected
  path". Ordinary discussion must not become durable memory.

## Disabled for M6

- `lantern_correct`, `lantern_foreman_queue`, `lantern_foreman_review`,
  and any authority surface. M6 is shared visibility, not shared mutation.

## Notes

- This policy is documented, not mechanically enforced: the Codex/Desktop
  MCP config has no per-tool filter, so the bridge exposes Lantern's full
  bounded catalogue. Least surface wins in practice — use only the tools
  above unless a later packet changes the policy with Matthew's approval.
- No secrets in markers, handoffs, or receipts.
