# M0 — Connectivity Proof

Goal: prove `Pi → Lantern Keeper → ChatGPT Desktop` can operate on the same
canonical Lantern record. This project proves the **Pi side** and produces
clear instructions + evidence for the ChatGPT-side check. No new protocol:
Lantern's existing MCP tools only.

## Pi side (this repo)

1. Build Lantern once:
   `cargo build --manifest-path D:\Projects\lantern-keeper\Cargo.toml -p lighting`
2. Run an isolated service (temp SurrealKV store — never Matthew's data):
   ```powershell
   $env:LIGHTING_STORAGE = "embedded-surrealkv"
   $env:LIGHTING_SURREAL_PATH = "<isolated dir>"
   lighting.exe serve  # 127.0.0.1:4317
   ```
3. Pi MCP: Lantern lives in `~/.pi/agent/mcp-adapter.json` (the adapter
   owns sessions; legacy `mcp.json` is left alone so servers never
   double-start). `/keeper status` shows `Lantern: READY`.
4. Run the scripted proof: `PI_QA_LIVE_LANTERN=1 npm run test:live`
   executes `LanternClient.connectivityProof()` —
   `lantern_status → lantern_remember(marker) → lantern_search(marker) →
lantern_why(id) → reconnect → search` — every step graded, artifacts in
   `.pi/qa/m0-proof-<stamp>.json`.
5. Full restart: stop `serve`, restart on the same store, search the marker
   again → persistence confirmed.

## ChatGPT Desktop side (manual check for Matthew)

1. In ChatGPT Desktop with the same Lantern MCP configured, search for the
   marker recorded below (`pi-qa-m0-<timestamp>`).
2. Confirm the **same id and text** come back — same canonical record.
3. Run the equivalent `why`/provenance lookup and compare with the Pi-side
   trail.

## Current status (repair R1, 2026-10-01)

M0 Pi-side proof is **LIVE and passing**: the live test runs the real
`lighting mcp` stdio bridge against the local service, every required step
`EXECUTED`. Without `PI_QA_LIVE_LANTERN=1` the test skips; with a null
caller the proof reports `passed: false` (no fake PASS possible).

## Evidence table (repair R1 run)

| Step         | Tool             | Grade    | Detail                                      |
| ------------ | ---------------- | -------- | ------------------------------------------- |
| status       | lantern_status   | EXECUTED | service 0.1.0, durable Source storage ready |
| remember     | lantern_remember | EXECUTED | kind=reference, see marker/memory_id below  |
| retrieve     | lantern_search   | EXECUTED | phrase=marker, id match                     |
| provenance   | lantern_why      | EXECUTED | memory + actor trail                        |
| reconnect    | (fresh bridge)   | EXECUTED | fresh connection healthy                    |
| post-restart | lantern_search   | EXECUTED | marker survives reconnect                   |
| full restart | kill + serve     | EXECUTED | same id retrieved, provenance intact        |
| chatgpt-side | (manual, Lucy)   | PENDING  | see handoff in the repair report            |
