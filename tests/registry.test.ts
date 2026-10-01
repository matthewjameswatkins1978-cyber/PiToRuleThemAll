import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/adapters/registry.js";

describe("createRegistry", () => {
  it("resolves degraded clients with explicit reasons when nothing is configured", async () => {
    const reg = await createRegistry("/tmp", {
      PI_QA_LANTERN_BIN: "Z:\\nope\\lighting.exe",
      PI_QA_REUSERY_BIN: "Z:\\nope\\reusery.exe",
      TELLTAIL_REPO: "Z:\\nope",
    });
    assert.ok(reg.lantern);
    assert.ok(reg.reusery);
    assert.ok(reg.telltail);
    assert.ok(reg.tethers);
    // No null connectors anywhere: degradation is explicit state.
    assert.equal(reg.lantern.describe().state, "NOT_CONFIGURED");
    assert.equal(await reg.lanternSession(), null);
    const all = reg.describeAll();
    assert.equal(all.length, 4);
    for (const d of all) {
      assert.ok(typeof d.reason === "string" && d.reason.length > 0);
    }
  });
});
