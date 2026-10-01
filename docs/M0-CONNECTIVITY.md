# M0 — Connectivity Proof

Goal: prove `Pi → Lantern Keeper → ChatGPT Desktop` can operate on the same
canonical Lantern record. This project proves the **Pi side** and produces
clear instructions + evidence for the ChatGPT-side check. No new protocol:
Lantern's existing MCP tools only.

## Pi side (this repo)

1. Connect Lantern MCP in Pi. Add to `~/.pi/agent/mcp.json` (user scope —
   keep credentials out of project files):
   ```json
   {
     "mcpServers": {
       "lantern": {
         "command": "<lantern-mcp-command>",
         "args": [],
         "description": "Lantern Keeper memory and provenance"
       }
     }
   }
   ```
   Then `pi mcp list` must show `lantern` connected with tools including
   `lantern_context`, `lantern_remember`, `lantern_search`, `lantern_why`,
   `lantern_correct`, `lantern_status`.
2. In a Pi session with this package installed, run `/keeper status`.
   Expected: `Lantern: CONNECTED (OBSERVED)` with the tool list.
3. Run the scripted proof (requires Lantern + uses the fake-safe client):
   the `LanternClient.connectivityProof()` sequence —
   `lantern_status → lantern_remember(marker) → lantern_search(marker) →
lantern_why(id)`. Record the marker, the returned id, and each grade.
4. Restart the local Pi session (or run `pi mcp list` in a fresh shell) and
   confirm the marker is still retrievable → persistence confirmed.

## ChatGPT Desktop side (manual check for Matthew)

1. In ChatGPT Desktop with the same Lantern MCP configured, search for the
   marker recorded above (`pi-qa-m0-<timestamp>`).
2. Confirm the **same id and text** come back — same canonical record.
3. Run the equivalent `why`/provenance lookup and compare with the Pi-side
   trail.

## Current status (2026-10-01, build environment)

- Lantern MCP is **not connected** in this environment (`pi mcp list`: no
  servers; known tools are `basic-memory_*`, unrelated to Lantern).
- Therefore M0 Pi-side proof is recorded as **INCONCLUSIVE (UNAVAILABLE)**,
  not as a pass: `tests/m0-lantern.live.test.ts` is skipped unless
  `PI_QA_LIVE_LANTERN=1`, and the deterministic suite proves the adapter
  degrades honestly (status/CONTEXT/why → UNAVAILABLE, nothing invented).
- To complete M0 live: configure Lantern MCP, run
  `PI_QA_LIVE_LANTERN=1 npm test`, and fill in the evidence table below.

## Evidence table (fill when live)

| Step         | Tool             | Grade | Detail     |
| ------------ | ---------------- | ----- | ---------- |
| status       | lantern_status   |       |            |
| remember     | lantern_remember |       | marker/id: |
| retrieve     | lantern_search   |       |            |
| provenance   | lantern_why      |       |            |
| restart      | (fresh session)  |       |            |
| chatgpt-side | (manual)         |       | same id?   |
