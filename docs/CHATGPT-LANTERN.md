# ChatGPT Desktop ↔ Lantern Keeper (M6)

One memory. Two clients. Same evidence.

## What runs

- **Lantern service** on `127.0.0.1:4317` (canonical store):
  ```powershell
  $env:LIGHTING_STORAGE = "embedded-surrealkv"
  $env:LIGHTING_SURREAL_PATH = "<store dir>"
  D:\Projects\lantern-keeper\target\debug\lighting.exe serve
  ```
- **ChatGPT Desktop** launches `lighting mcp` (stdio) itself from its own
  MCP config. No second server, no forwarder, no sync job.

## What stays local

Loopback only. No hosting, no bill, no firewall port, no credentials in
files. Lantern remains the only memory database.

## How ChatGPT Desktop connects

`~/.codex/config.toml` → `[mcp_servers.lantern]` (see
`integrations/chatgpt/lantern-chatgpt.toml` for the exact block).
After editing, restart ChatGPT Desktop or reload its MCP panel — Pi
cannot approve that UI step for you. If the app needs a one-time manual
"connect" action, that is inherent to its setup; it is documented here,
not automated.

## Which Lantern tools are exposed

Read-first (`integrations/chatgpt/policy.md`):
`lantern_status`, `lantern_search`, `lantern_context`, `lantern_why`
(bounded budgets). `lantern_remember` only on explicit user intent.
`lantern_correct`, foreman and authority surfaces are out of scope.

## How to create a proof marker

In any Pi session with this package: `/keeper proof`
(one invocation = one `reference` marker). It prints the marker, memory
ID, provenance, a WAITING_FOR_CHATGPT status, and the copyable handoff.

## How Lucy verifies it

Paste the handoff. Lucy calls `lantern_search` with the marker phrase,
then `lantern_why` with the memory ID, and compares: marker, memory ID,
kind, originator, holder. Same ID = shared storage. Same text with a
different ID = copying, rejected.

## How to diagnose failure

- `/qa doctor`: Lantern row (service), ChatGPT bridge row (Desktop
  config + bridge start), Cross-client row (PENDING_USER / VERIFIED).
- Service down → start command above.
- Marker missing on Lucy's side → her bridge hits a different
  service/store. Confirm `LIGHTING_SERVICE_URL=http://127.0.0.1:4317`
  and that port 4317 serves the canonical store.
- Only one service may own the port. Never run two Lantern services
  with different stores while proving shared memory.
