# ChatGPT Desktop ↔ Lantern Keeper bridge (M6)

One memory. Two clients. Same evidence.

## What runs

1. **Lantern service** (canonical store, Matthew's data or the isolated
   proof store — exactly one must listen on `127.0.0.1:4317`):
   ```powershell
   $env:LIGHTING_STORAGE = "embedded-surrealkv"
   $env:LIGHTING_SURREAL_PATH = "<store dir>"
   D:\Projects\lantern-keeper\target\debug\lighting.exe serve
   ```
2. **ChatGPT Desktop** launches the bridge itself from its MCP config —
   no separate process to babysit:
   `D:\Projects\lantern-keeper\target\debug\lighting.exe mcp`
   (stdio, same binary Pi uses; no forwarding wrapper, no second server).

## What stays local

- Everything: loopback only, no hosting, no bill, no firewall port.
- No sync database, no export/import, no replication layer.
- No ChatGPT memory database. Lantern remains authoritative.

## How ChatGPT Desktop connects

ChatGPT Desktop / Codex app reads MCP servers from `~/.codex/config.toml`.
The `[mcp_servers.lantern]` entry (see `lantern-chatgpt.toml`, the source
of truth) points at the current build. After editing, restart ChatGPT
Desktop (or reload its MCP panel) — Pi cannot approve that UI step for you.

## Which Lantern tools are exposed

Read-first (`policy.md`): `lantern_status`, `lantern_search`,
`lantern_context`, `lantern_why`. `lantern_remember` only on explicit
user intent ("Lucy, record this decision"). `lantern_correct`, foreman
and authority surfaces are out of scope for M6.

## Proof markers and Lucy verification

`/keeper proof` (Pi side) creates one `reference` marker and prints the
copyable handoff. Paste it to Lucy; she retrieves the same memory ID
through her Lantern tools. Matching IDs = shared storage. Same text
with a different ID would prove copying, not sharing.

## Diagnose failure

- `/qa doctor` — Lantern row (service) and ChatGPT bridge row (config).
- Service down → start command above.
- Marker missing on Lucy's side → she is hitting a different
  service/store (check `LIGHTING_SERVICE_URL` / port 4317 occupant).
