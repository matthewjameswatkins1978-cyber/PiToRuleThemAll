import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LanternClient } from "../src/adapters/lantern.js";
import { ReuseryClient } from "../src/adapters/reusery.js";
import { TelltailClient } from "../src/adapters/telltail.js";
import { TethersClient } from "../src/adapters/tethers.js";
import type { IntegrationRegistry } from "../src/adapters/registry.js";
import { doctor, renderDoctor } from "../src/qa/doctor.js";

function registry(): IntegrationRegistry {
  const lantern = new LanternClient(null);
  const reusery = new ReuseryClient(null);
  const telltail = new TelltailClient(null);
  const tethers = new TethersClient(null);
  return {
    lantern,
    lanternSession: async () => null,
    lanternReason: "test",
    reusery,
    telltail,
    tethers,
    describeAll: () => [
      lantern.describe(),
      reusery.describe(),
      telltail.describe(),
      tethers.describe(),
    ],
  };
}

describe("doctor", () => {
  it("reports one compact row per integration with states", async () => {
    const rows = await doctor({ registry: registry() });
    const names = rows.map((r) => r.name);
    for (const want of [
      "Pi",
      "Git",
      "GitHub",
      "rg",
      "ast-grep",
      "Lantern",
      "Telltail",
      "Reusery",
      "Tethers",
      "Verifier",
    ]) {
      assert.ok(names.includes(want), `missing row: ${want}`);
    }
    const states = new Set(rows.map((r) => r.state));
    for (const s of states)
      assert.ok(
        ["READY", "UNAVAILABLE", "MISCONFIGURED", "OPTIONAL"].includes(s),
      );
    const text = renderDoctor(rows);
    assert.ok(text.includes("Lantern"));
    assert.ok(text.split("\n").length === rows.length);
  });
  it("Reusery without bridge is OPTIONAL, not a failure", async () => {
    const rows = await doctor({ registry: registry() });
    const re = rows.find((r) => r.name === "Reusery");
    assert.equal(re?.state, "OPTIONAL");
  });
  it("smoke flag runs the verifier probe", async () => {
    const rows = await doctor({
      registry: registry(),
      smokeVerifier: async () => ({ ok: true, detail: "smoke ok" }),
    });
    const v = rows.find((r) => r.name === "Verifier");
    assert.equal(v?.detail, "smoke ok");
  });
});
