import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LanternClient } from "../src/adapters/lantern.js";
import {
  ReuseryClient,
  shouldConsultReusery,
} from "../src/adapters/reusery.js";
import { TelltailClient } from "../src/adapters/telltail.js";
import { TethersClient } from "../src/adapters/tethers.js";

describe("LanternClient without a server", () => {
  it("degrades to UNAVAILABLE and never invents memory", async () => {
    const c = new LanternClient(null);
    assert.equal(c.configured, false);
    const st = await c.status();
    assert.equal(st.reachable, false);
    assert.equal(st.grade, "UNAVAILABLE");
    const ctx = await c.context("anything");
    assert.equal(ctx.grade, "UNAVAILABLE");
    assert.deepEqual(ctx.pack.decisions, []);
    assert.equal(ctx.pack.id, null);
    const why = await c.why("claim-1");
    assert.equal(why.grade, "UNAVAILABLE");
    assert.deepEqual(why.trail, []);
  });
  it("connectivityProof reports unreachable honestly", async () => {
    const c = new LanternClient(null);
    const p = await c.connectivityProof();
    assert.equal(p.steps[0]?.grade, "UNAVAILABLE");
  });
  it("fake caller returns structured packs", async () => {
    const c = new LanternClient({
      call: async (tool) => {
        if (tool === "lantern_status") return { ok: true, data: {} };
        if (tool === "lantern_context")
          return {
            ok: true,
            data: {
              id: "pack-1",
              decisions: [{ id: "d1", summary: "use files" }],
              rejectedPaths: ["redis"],
              negativeConstraints: ["no new db"],
              provenance: ["ep-1"],
            },
          };
        return { ok: false, error: "unknown" };
      },
    });
    const st = await c.status();
    assert.equal(st.grade, "EXECUTED");
    const ctx = await c.context("q");
    assert.equal(ctx.grade, "EXECUTED");
    assert.equal(ctx.pack.id, "pack-1");
    assert.deepEqual(ctx.pack.rejectedPaths, ["redis"]);
  });
});

describe("TelltailClient", () => {
  it("UNAVAILABLE without caller; core QA may continue", async () => {
    const c = new TelltailClient(null);
    const r = await c.evaluate("s", {});
    assert.equal(r.grade, "UNAVAILABLE");
  });
});

describe("ReuseryClient", () => {
  it("proportionality gate: retry consults, typo fix does not", () => {
    assert.equal(
      shouldConsultReusery("add http retry with backoff").consult,
      true,
    );
    assert.equal(
      shouldConsultReusery("fix a typo in a comment").consult,
      false,
    );
    assert.equal(
      shouldConsultReusery("rename a local variable").consult,
      false,
    );
  });
  it("lack of evidence becomes NEEDS_VERIFICATION, never BUILD_LOCALLY", async () => {
    const c = new ReuseryClient(null);
    const r = await c.query("add http retry with backoff");
    assert.equal(r.grade, "UNAVAILABLE");
    assert.equal(r.outcome, "NEEDS_VERIFICATION");
    const local = await c.query("fix typo");
    assert.equal(local.outcome, "NEEDS_VERIFICATION");
  });
  it("passes through real outcomes honestly", async () => {
    const c = new ReuseryClient({
      query: async () => ({
        ok: true,
        outcome: "DEPEND",
        candidates: ["p-retry"],
      }),
    });
    const r = await c.query("add http retry with backoff");
    assert.equal(r.outcome, "DEPEND");
    assert.deepEqual(r.candidates, ["p-retry"]);
  });
});

describe("TethersClient", () => {
  it("check is read-only and degrades to UNAVAILABLE", async () => {
    const c = new TethersClient(null);
    const s = await c.check("delete-prod", {});
    assert.equal(s.decision, "UNAVAILABLE");
    // No authorise method exists on purpose
    assert.equal("authorise" in c, false);
    assert.equal("authorize" in c, false);
  });
  it("packageStop carries reason + evidence, authorises nothing", () => {
    const c = new TethersClient(null);
    const p = c.packageStop({
      reason: "would drop the database",
      evidence: ["diff deletes migration guard"],
      specId: "qa-spec-1",
      receiptId: "qa-1",
    });
    assert.equal(p.grade, "EXECUTED");
    assert.ok(p.text.includes("authorises nothing"));
    assert.ok(p.text.includes("would drop the database"));
  });
});
