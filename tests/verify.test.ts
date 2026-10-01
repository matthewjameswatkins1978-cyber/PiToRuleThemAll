import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LanternClient } from "../src/adapters/lantern.js";
import { ReuseryClient } from "../src/adapters/reusery.js";
import { TelltailClient } from "../src/adapters/telltail.js";
import { TethersClient } from "../src/adapters/tethers.js";
import { preflight } from "../src/qa/preflight.js";
import { verify } from "../src/qa/verify.js";
import type { SpawnFn } from "../src/qa/independent-review.js";
import { cleanup, makeTempRepo } from "./helpers.js";

const deps = () => ({
  lantern: new LanternClient(null),
  reusery: new ReuseryClient(null),
  telltail: new TelltailClient(null),
  tethers: new TethersClient(null),
});

function fakeSpawnFor(result: unknown): SpawnFn {
  return async () => ({
    exitCode: 0,
    stdout:
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(result) }],
        },
      }) + "\n",
    stderr: "",
  });
}

const passResult = {
  verdict: "PASS",
  integrity: "OK",
  checks: [
    {
      requirement_id: "A1",
      status: "satisfied",
      evidence_grade: "EXECUTED",
      evidence: { command: "npm test" },
    },
  ],
  notes: [],
  stopReasons: [],
  integritySignals: [],
};

async function setupRepo(): Promise<string> {
  const dir = await makeTempRepo({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "a.test.js": "const t=require('node:test');t.test('x',()=>{});\n",
  });
  const r = await preflight(
    dir,
    {
      rawRequest: "Add X",
      normalizedIntent: "Add X",
      acceptance: [{ id: "A1", requirement: "X works" }],
    },
    { lantern: new LanternClient(null), reusery: new ReuseryClient(null) },
  );
  return dir + "::" + r.specId;
}

function split(setup: string): { dir: string; specId: string } {
  const [dir, specId] = setup.split("::") as [string, string];
  return { dir, specId };
}

describe("verify", () => {
  it("PASS path: receipt validates, pins spec, records EXECUTED tests", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        spawn: fakeSpawnFor(passResult),
      });
      assert.equal(o.receipt.verdict, "PASS");
      assert.equal(o.receipt.integrity, "OK");
      assert.equal(o.receipt.intent.spec_id, specId);
      assert.equal(o.receipt.intent.spec_revision, 1);
      assert.equal(o.promptWithheld, true);
      assert.ok(fs.existsSync(o.receiptFile));
      assert.equal(o.receipt.tests.executed, 1);
      assert.equal(o.receipt.subject.remote_verified, false);
    } finally {
      cleanup(dir);
    }
  });
  it("FAIL path: verifier violations become FAIL", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        spawn: fakeSpawnFor({
          ...passResult,
          verdict: "FAIL",
          checks: [
            {
              requirement_id: "A1",
              status: "violated",
              evidence_grade: "EXECUTED",
            },
          ],
        }),
      });
      assert.equal(o.receipt.verdict, "FAIL");
      assert.equal(o.receipt.intent.satisfied, false);
    } finally {
      cleanup(dir);
    }
  });
  it("INCONCLUSIVE path: model verifier unavailable", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        spawn: async () => ({ exitCode: 1, stdout: "", stderr: "no auth" }),
      });
      assert.equal(o.receipt.verdict, "INCONCLUSIVE");
      assert.ok(
        (o.receipt.unknowns ?? []).length > 0 ||
          o.receipt.integrity === "SUSPECT",
      );
    } finally {
      cleanup(dir);
    }
  });
  it("STOP_RECOMMENDED path with packaged evidence", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        spawn: fakeSpawnFor({
          ...passResult,
          verdict: "STOP_RECOMMENDED",
          stopReasons: ["would drop prod data"],
        }),
      });
      assert.equal(o.receipt.verdict, "STOP_RECOMMENDED");
    } finally {
      cleanup(dir);
    }
  });
  it("classifies builder claims only after the initial verdict", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        builderReport: "- tests pass\n- docs updated\n",
        spawn: fakeSpawnFor(passResult),
      });
      const bc = o.receipt.builder_claims;
      assert.equal(bc?.not_checked?.length ?? 0, 2);
      assert.equal(bc?.supported?.length ?? 0, 0);
    } finally {
      cleanup(dir);
    }
  });
  it("frozen spec cannot silently mutate: unknown spec id throws", async () => {
    const { dir } = split(await setupRepo());
    try {
      await assert.rejects(
        () => verify(dir, deps(), { specId: "qa-spec-nope" }),
        /Run \/qa preflight first/,
      );
    } finally {
      cleanup(dir);
    }
  });
  it("requireRemotePush marks unverified REMOTE when HEAD is not on the remote", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        requireRemotePush: true,
        spawn: fakeSpawnFor(passResult),
      });
      const remote = o.receipt.verification.find(
        (v) => v.requirement_id === "REMOTE",
      );
      assert.ok(remote);
      assert.equal(remote.status, "unverified");
      assert.ok(
        (o.receipt.unknowns ?? []).some((u) =>
          u.includes("remote push required"),
        ),
      );
    } finally {
      cleanup(dir);
    }
  });
  it("latest spec is used when no id is given", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), { spawn: fakeSpawnFor(passResult) });
      assert.equal(o.receipt.intent.spec_id, specId);
    } finally {
      cleanup(dir);
    }
  });
  it("receipt file round-trips through the loader", async () => {
    const { dir, specId } = split(await setupRepo());
    try {
      const o = await verify(dir, deps(), {
        specId,
        spawn: fakeSpawnFor(passResult),
      });
      const { loadReceipt } = await import("../src/qa/receipt.js");
      const id = path.basename(o.receiptFile, ".json");
      const loaded = loadReceipt(dir, id);
      assert.equal(loaded.id, o.receipt.id);
    } finally {
      cleanup(dir);
    }
  });
});
