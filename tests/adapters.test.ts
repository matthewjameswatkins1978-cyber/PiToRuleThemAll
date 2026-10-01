import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LANTERN_MEMORY_KINDS,
  LanternClient,
  translateContext,
  translateProvenance,
} from "../src/adapters/lantern.js";
import {
  ReuseryClient,
  shouldConsultReusery,
} from "../src/adapters/reusery.js";
import {
  resolveTelltailCommand,
  shouldRunTelltail,
  TelltailClient,
} from "../src/adapters/telltail.js";
import {
  resolveTethersCommand,
  TethersClient,
} from "../src/adapters/tethers.js";

function fixtures(): Record<string, unknown> {
  const root = path.resolve(import.meta.dirname, "..", "..");
  return JSON.parse(
    fs.readFileSync(
      path.join(root, "fixtures", "lantern", "responses.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function fakeLantern(seen: { tool: string; args: Record<string, unknown> }[]) {
  const fx = fixtures();
  return {
    call: async (tool: string, args: Record<string, unknown>) => {
      seen.push({ tool, args });
      if (tool === "lantern_status") return { ok: true, data: fx["status"] };
      if (tool === "lantern_remember")
        return { ok: true, data: fx["remember_soft"] };
      if (tool === "lantern_search") return { ok: true, data: fx["search"] };
      if (tool === "lantern_why") return { ok: true, data: fx["why_memory"] };
      if (tool === "lantern_context") return { ok: true, data: fx["context"] };
      return { ok: false, error: `unknown tool ${tool}` };
    },
  };
}

describe("LanternClient without a server", () => {
  it("degrades to NOT_CONFIGURED and never invents memory", async () => {
    const c = new LanternClient(null);
    assert.equal(c.configured, false);
    assert.equal(c.describe().state, "NOT_CONFIGURED");
    const st = await c.status();
    assert.equal(st.reachable, false);
    assert.equal(st.grade, "UNAVAILABLE");
    const ctx = await c.context("anything");
    assert.equal(ctx.grade, "UNAVAILABLE");
    assert.deepEqual(ctx.pack.decisions, []);
    assert.equal(ctx.pack.id, null);
    const why = await c.why({ memory_id: "x" });
    assert.equal(why.ok, false);
    assert.deepEqual(why.trail, []);
  });
  it("proof with null caller cannot pass", async () => {
    const proof = await new LanternClient(null).connectivityProof({
      marker: "m",
      content: "c",
      reconnect: async () => null,
    });
    assert.equal(proof.passed, false);
  });
});

describe("LanternClient live contract", () => {
  it("status reads version, remember validates kind locally", async () => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const c = new LanternClient(fakeLantern(seen));
    const st = await c.status();
    assert.equal(st.grade, "EXECUTED");
    assert.equal(c.describe().state, "READY");
    const bad = await c.remember("evidence", "x");
    assert.equal(bad.ok, false);
    assert.ok(bad.error?.includes("unsupported kind"));
    assert.ok(LANTERN_MEMORY_KINDS.includes("reference"));
    assert.ok(!LANTERN_MEMORY_KINDS.includes("memory" as never));
  });
  it("search uses phrase/include_archived/limit (never query/max_items)", async () => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const c = new LanternClient(fakeLantern(seen));
    const r = await c.search("marker", { includeArchived: false, limit: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 3);
    assert.deepEqual(seen[0]?.args, {
      phrase: "marker",
      include_archived: false,
      limit: 10,
    });
    assert.ok(!("query" in (seen[0]?.args ?? {})));
  });
  it("why accepts memory_id, belief_id and query shapes", async () => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const c = new LanternClient(fakeLantern(seen));
    await c.why({ memory_id: "m1" });
    await c.why({ belief_id: "b1" });
    await c.why({ query: "what persists?" });
    assert.deepEqual(
      seen.map((s) => s.args),
      [{ memory_id: "m1" }, { belief_id: "b1" }, { query: "what persists?" }],
    );
    assert.ok(seen.every((s) => s.tool === "lantern_why"));
  });
  it("why uses memory_id; context maps budgets and translates", async () => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const c = new LanternClient(fakeLantern(seen));
    const w = await c.why({ memory_id: "abc" });
    assert.equal(w.ok, true);
    assert.deepEqual(seen[0]?.args, { memory_id: "abc" });
    const ctx = await c.context("persistence?", {
      itemBudget: 8,
      tokenBudget: 2000,
    });
    assert.equal(ctx.grade, "EXECUTED");
    assert.deepEqual(seen[1]?.args, {
      query: "persistence?",
      item_budget: 8,
      token_budget: 2000,
    });
    assert.ok(!("max_items" in (seen[1]?.args ?? {})));
    assert.equal(ctx.pack.id, "ctx-1234abcd");
  });
});

describe("Lantern raw → ContextPack translation", () => {
  it("maps beliefs, rejected paths, constraints, provenance", () => {
    const pack = translateContext(fixtures()["context"]);
    assert.equal(pack.id, "ctx-1234abcd");
    assert.deepEqual(pack.decisions, [
      { id: "belief-1", summary: "config.persistence = local-file" },
    ]);
    assert.deepEqual(pack.rejectedPaths, ["Redis rejected for this project"]);
    assert.deepEqual(pack.negativeConstraints, [
      "local persistence preferred unless measurable need arises",
    ]);
    assert.ok(pack.provenance.includes("context:ctx-1234abcd"));
    assert.ok(pack.provenance.includes("belief:belief-1"));
    assert.ok(pack.provenance.includes("source:source-9"));
  });
  it("why translation yields memory + provenance pointers", () => {
    const trail = translateProvenance(fixtures()["why_memory"]);
    assert.ok(trail[0]?.startsWith("memory:"));
    assert.ok(trail.some((t) => t.startsWith("originator_actor_id:")));
  });
  it("non-records translate to empty packs, never throw", () => {
    assert.deepEqual(translateContext(null).decisions, []);
    assert.deepEqual(translateProvenance("junk"), []);
  });
});

describe("TelltailClient", () => {
  it("UNAVAILABLE without resolution; gating policy", async () => {
    const c = new TelltailClient(null);
    assert.equal(c.describe().state, "NOT_CONFIGURED");
    const r = await c.analyze({ scenario: "s", trace: "t", worker: "w" });
    assert.equal(r.grade, "UNAVAILABLE");
    assert.equal(shouldRunTelltail("LIGHT").run, false);
    assert.equal(shouldRunTelltail("LIGHT", { force: true }).run, true);
    assert.equal(shouldRunTelltail("DEEP").run, true);
    assert.equal(shouldRunTelltail("STANDARD").run, false);
    assert.equal(
      shouldRunTelltail("STANDARD", { behaviouralNeed: true }).run,
      true,
    );
  });
  it("prefers sg over ast-grep-style PATH order (injectable)", async () => {
    const cmd = await resolveTelltailCommand({
      which: async (exe) =>
        exe === "telltail" ? "C:\\bin\\telltail.exe" : null,
    });
    assert.equal(cmd?.exe, "C:\\bin\\telltail.exe");
    const none = await resolveTelltailCommand({
      which: async () => null,
      repoDir: "Z:\\nope",
    });
    assert.equal(none, null);
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
  });
  it("NOT_NEEDED is distinct from UNAVAILABLE", async () => {
    const c = new ReuseryClient(null);
    const local = await c.query("fix typo");
    assert.equal(local.state, "NOT_NEEDED");
    assert.ok(local.note.startsWith("NOT_NEEDED"));
    const gated = await c.query("add http retry with backoff");
    assert.equal(gated.state, "NOT_CONFIGURED");
    assert.equal(gated.outcome, "NEEDS_VERIFICATION");
  });
  it("catalog + resolve flow with fake bridge", async () => {
    const c = new ReuseryClient({
      catalog: async () => ({
        ok: true,
        primitives: [
          {
            primitive_id: "p1",
            contract_id: "c1",
            name: "retry with backoff",
            description: "bounded http retry",
          },
        ],
      }),
      resolve: async () => ({
        ok: true,
        status: "needs_verification",
        outcome: "NEEDS_VERIFICATION",
        reasons: ["no candidates"],
      }),
    });
    const r = await c.query("add http retry with backoff");
    assert.equal(r.grade, "EXECUTED");
    assert.equal(r.outcome, "NEEDS_VERIFICATION");
    assert.ok(r.candidates[0]?.includes("retry with backoff"));
  });
});

describe("TethersClient", () => {
  it("read-only: probe degrades, no authorise method exists", async () => {
    const c = new TethersClient(null);
    assert.equal(c.describe().state, "NOT_CONFIGURED");
    const p = await c.probe();
    assert.equal(p.ok, false);
    assert.equal("authorise" in c, false);
    assert.equal("authorize" in c, false);
  });
  it("resolves via fake which; evaluate needs explicit config", async () => {
    const cmd = await resolveTethersCommand({
      which: async (exe) => (exe === "tethers" ? "C:\\t\\tethers.exe" : null),
    });
    assert.equal(cmd?.exe, "C:\\t\\tethers.exe");
    const c = new TethersClient(cmd);
    const s = await c.evaluate({ mode: "check", config: "" });
    assert.equal(s.decision, "UNAVAILABLE");
    assert.ok(s.note.includes("explicit config"));
  });
  it("packageStop carries reason + evidence, authorises nothing", () => {
    const c = new TethersClient(null);
    const p = c.packageStop({
      reason: "would drop prod",
      evidence: ["diff deletes guard"],
      specId: "s",
      receiptId: "r",
    });
    assert.equal(p.grade, "EXECUTED");
    assert.ok(p.text.includes("authorises nothing"));
  });
});
