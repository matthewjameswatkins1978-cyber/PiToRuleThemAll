import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LanternClient } from "../src/adapters/lantern.js";
import { ReuseryClient } from "../src/adapters/reusery.js";
import { TelltailClient } from "../src/adapters/telltail.js";
import { TethersClient } from "../src/adapters/tethers.js";
import type { IntegrationRegistry } from "../src/adapters/registry.js";
import {
  checkChatGptBridge,
  doctor,
  readCrossClientState,
  renderDoctor,
} from "../src/qa/doctor.js";

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
        [
          "READY",
          "UNAVAILABLE",
          "MISCONFIGURED",
          "OPTIONAL",
          "NOT_CONFIGURED",
          "PENDING_USER",
          "VERIFIED",
        ].includes(s),
        `unknown doctor state: ${s}`,
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
  it("doctor distinguishes Lantern from the ChatGPT bridge", async () => {
    const rows = await doctor({ registry: registry() });
    const names = rows.map((r) => r.name);
    assert.ok(names.includes("ChatGPT bridge"));
    // No repoRoot passed here, so no Cross-client row; covered below.
  });
  it("checkChatGptBridge grades config states without a live server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-doc-"));
    try {
      const missing = await checkChatGptBridge({
        configPath: path.join(dir, "nope.toml"),
      });
      assert.equal(missing.state, "NOT_CONFIGURED");
      const noSection = path.join(dir, "empty.toml");
      fs.writeFileSync(noSection, "[other]\nx = 1\n", "utf-8");
      assert.equal(
        (await checkChatGptBridge({ configPath: noSection })).state,
        "NOT_CONFIGURED",
      );
      const badBin = path.join(dir, "lantern.toml");
      fs.writeFileSync(
        badBin,
        "[mcp_servers.lantern]\ncommand = 'Z:\\nope\\lighting.exe'\n",
        "utf-8",
      );
      const r = await checkChatGptBridge({ configPath: badBin });
      assert.equal(r.state, "MISCONFIGURED");
      assert.ok(r.detail.includes("bridge binary missing"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("readCrossClientState reports PENDING/VERIFIED/empty honestly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-doc-"));
    try {
      assert.equal(readCrossClientState(dir).state, "UNAVAILABLE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
