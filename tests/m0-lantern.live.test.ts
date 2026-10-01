/**
 * M0 live Lantern proof. Skipped unless PI_QA_LIVE_LANTERN=1 AND a Lantern
 * MCP caller is available. There is deliberately no fake-pass path: without
 * a live server the proof is INCONCLUSIVE (UNAVAILABLE), never PASS.
 *
 * To run live, provide the server via PI_QA_LANTERN_MCP_CMD (stdio command,
 * space-separated, e.g. "lantern-mcp --stdio") — or wire a real caller and
 * set PI_QA_LIVE_LANTERN=1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LanternClient } from "../src/adapters/lantern.js";

const LIVE = process.env["PI_QA_LIVE_LANTERN"] === "1";

describe("M0 live Lantern connectivity", { skip: !LIVE }, () => {
  it("status → remember → search → why all EXECUTED", async () => {
    const c = new LanternClient(null); // replaced by a real caller when wired
    const proof = await c.connectivityProof();
    // Without a wired caller this fails loudly — that is the honest result.
    assert.ok(
      proof.steps.every((s) => s.grade === "EXECUTED"),
      JSON.stringify(proof.steps, null, 2),
    );
  });
});

describe("M0 proof honesty guard", () => {
  it("documents INCONCLUSIVE when Lantern is not configured", async () => {
    if (LIVE) return; // live run above owns the verdict
    const c = new LanternClient(null);
    const proof = await c.connectivityProof();
    assert.equal(proof.steps[0]?.grade, "UNAVAILABLE");
  });
});
