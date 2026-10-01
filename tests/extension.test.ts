import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LanternClient } from "../src/adapters/lantern.js";
import { ReuseryClient } from "../src/adapters/reusery.js";
import { TelltailClient } from "../src/adapters/telltail.js";
import { TethersClient } from "../src/adapters/tethers.js";
import type { IntegrationRegistry } from "../src/adapters/registry.js";
import {
  findLanternTools,
  handleKeeper,
  handleQa,
  matchLanternTool,
  parsePreflightArgs,
  registerQaExtension,
  splitArgs,
  toolContextLanternCaller,
} from "../extensions/pi-qa/index.js";
import type { PiApi, PiCommandContext } from "../src/pi-shim.js";

function fakePi(): {
  pi: PiApi;
  commands: Map<string, (a: string, c: PiCommandContext) => Promise<void>>;
  tools: Map<string, unknown>;
} {
  const commands = new Map();
  const tools = new Map();
  const pi: PiApi = {
    registerCommand: (name, opts) => {
      commands.set(name, opts.handler);
    },
    registerTool: (def) => {
      tools.set(def.name, def);
    },
    getAllTools: () => [{ name: "read" }, { name: "mcp__lantern__lantern_context" }, { name: "mcp__lantern__lantern_why" }],
  };
  return { pi, commands, tools };
}

function fakeCtx(cwd = "/tmp"): { ctx: PiCommandContext; seen: string[] } {
  const seen: string[] = [];
  return {
    ctx: {
      cwd,
      ui: {
        notify: (m) => {
          seen.push(m);
        },
        confirm: async () => true,
      },
    },
    seen,
  };
}

function fakeRegistry(opts: { lanternReady: boolean }): IntegrationRegistry {
  const lanternCaller = opts.lanternReady
    ? {
        call: async (tool: string) => {
          if (tool === "lantern_status") return { ok: true, data: { ready: { ready: true }, version: { version: "0.1.0" } } };
          if (tool === "lantern_context")
            return {
              ok: true,
              data: {
                context: {
                  id: "ctx-1",
                  current_beliefs: [{ id: "b1", subject_key: "s", predicate_key: "p", current_value: "v" }],
                  soft_memories: [{ id: "m1", kind: "rejected_path", content: "no redis" }],
                },
              },
            };
          if (tool === "lantern_why")
            return { ok: true, data: { memory_item: { id: "m1" }, provenance: { holder_actor_id: "matthew" } } };
          return { ok: false, error: "unknown" };
        },
      }
    : null;
  const lantern = new LanternClient(lanternCaller);
  return {
    lantern,
    lanternSession: async () => (lanternCaller ? { client: new LanternClient(lanternCaller), close: async () => {} } : null),
    lanternReason: opts.lanternReady ? "READY (fake)" : "NOT_CONFIGURED (fake)",
    reusery: new ReuseryClient(null),
    telltail: new TelltailClient(null),
    tethers: new TethersClient(null),
    describeAll: () => [lantern.describe(), new ReuseryClient(null).describe(), new TelltailClient(null).describe(), new TethersClient(null).describe()],
  };
}

const readyFactory = async () => fakeRegistry({ lanternReady: true });
const downFactory = async () => fakeRegistry({ lanternReady: false });

describe("extension registration", () => {
  it("registers qa + keeper commands and keeper_* tools", () => {
    const { pi, commands, tools } = fakePi();
    registerQaExtension(pi);
    assert.ok(commands.has("qa"));
    assert.ok(commands.has("keeper"));
    assert.ok(tools.has("keeper_context"));
    assert.ok(tools.has("keeper_why"));
  });
  it("exactly four user-facing commands/tools, no sprawl", () => {
    const { pi, commands, tools } = fakePi();
    registerQaExtension(pi);
    assert.equal(commands.size, 2);
    assert.equal(tools.size, 2);
  });
});

describe("matchLanternTool (defect G)", () => {
  it("matches across namespace shapes by known suffix", () => {
    assert.equal(matchLanternTool("mcp__lantern__lantern_status", "lantern_status"), true);
    assert.equal(matchLanternTool("mcp__lantern_keeper__lantern_status", "lantern_status"), true);
    assert.equal(matchLanternTool("lantern_status", "lantern_status"), true);
    assert.equal(matchLanternTool("mcp__lantern__lantern_context", "lantern_status"), false);
    assert.equal(matchLanternTool("mcp__other__status", "lantern_status"), false);
  });
  it("findLanternTools resolves both server namings", () => {
    const found = findLanternTools([{ name: "read" }, { name: "mcp__lantern__lantern_context" }, { name: "mcp__lantern_keeper__lantern_why" }]);
    assert.deepEqual(found, ["mcp__lantern__lantern_context", "mcp__lantern_keeper__lantern_why"]);
  });
});

describe("splitArgs (defect M)", () => {
  it("preserves quoted Windows paths", () => {
    assert.deepEqual(splitArgs('--report "D:\\Some Folder\\final report.txt" --require-push'), [
      "--report",
      "D:\\Some Folder\\final report.txt",
      "--require-push",
    ]);
  });
  it("splits plain flags", () => {
    assert.deepEqual(splitArgs("abc123 --claim-tests"), ["abc123", "--claim-tests"]);
  });
  it("empty input yields no tokens", () => {
    assert.deepEqual(splitArgs("   "), []);
  });
});

describe("parsePreflightArgs (defect L)", () => {
  it("preserves multiline acceptance IDs and sections", () => {
    const raw = "Add restart-safe config.\nAcceptance:\n- A1: value survives restart\n- A2: corrupt file errors cleanly\nConstraints:\n- no new deps\nSeams: persistence";
    const p = parsePreflightArgs(raw);
    assert.equal(p.rawRequest, "Add restart-safe config.");
    assert.ok(p.rawRequest.includes("\n") === false);
    assert.deepEqual(
      p.acceptance.map((a) => a.id),
      ["A1", "A2"],
    );
    assert.deepEqual(p.constraints, ["no new deps"]);
    assert.deepEqual(p.consequentialSeams, ["persistence"]);
  });
});

describe("/keeper one-action workflows (defect F)", () => {
  it("context returns a real pack in one action", async () => {
    const { pi } = fakePi();
    const { ctx, seen } = fakeCtx();
    await handleKeeper("context Terror Bats persistence decisions", ctx, pi, readyFactory);
    const out = seen.join("\n");
    assert.ok(out.includes("ctx-1"));
    assert.ok(out.includes("no redis"));
    assert.ok(out.includes("EXECUTED"));
  });
  it("why returns provenance in one action", async () => {
    const { pi } = fakePi();
    const { ctx, seen } = fakeCtx();
    await handleKeeper("why m1", ctx, pi, readyFactory);
    assert.ok(seen.join("\n").includes("holder_actor_id:matthew"));
  });
  it("unavailable Lantern gives explicit UNAVAILABLE, not a handoff", async () => {
    const { pi } = fakePi();
    const { ctx, seen } = fakeCtx();
    await handleKeeper("context anything", ctx, pi, downFactory);
    const out = seen.join("\n");
    assert.ok(out.includes("NOT_CONFIGURED") || out.includes("UNAVAILABLE"));
    assert.ok(!out.includes("Ask me to use"));
  });
});

describe("/qa help", () => {
  it("lists subcommands including doctor and spec-only", async () => {
    const { pi, commands } = fakePi();
    registerQaExtension(pi);
    const { ctx, seen } = fakeCtx();
    await commands.get("qa")!("help", ctx);
    const out = seen.join("\n");
    assert.ok(out.includes("preflight") && out.includes("verify") && out.includes("receipt") && out.includes("doctor"));
  });
});

describe("toolContextLanternCaller", () => {
  it("routes short names to full MCP tool names and parses JSON", async () => {
    const toolCtx = {
      cwd: "/tmp",
      ui: { notify: () => {}, confirm: async () => true },
      tools: [{ name: "mcp__lantern_keeper__lantern_context" }],
      executeTool: async () => ({
        result: { content: [{ type: "text", text: JSON.stringify({ id: "pack-1" }) }] },
        isError: false,
      }),
    };
    const caller = toolContextLanternCaller(["mcp__lantern_keeper__lantern_context"], toolCtx);
    const r = await caller.call("lantern_context", { query: "x" });
    assert.equal(r.ok, true);
    assert.equal((r.data as { id: string }).id, "pack-1");
    const missing = await caller.call("lantern_why", {});
    assert.equal(missing.ok, false);
  });
});

describe("handleQa verify flag parsing", () => {
  it("rejects unknown flags instead of ignoring them", async () => {
    const { pi } = fakePi();
    const { ctx, seen } = fakeCtx();
    await handleQa("verify --bogus", ctx, pi, downFactory);
    assert.ok(seen.join("\n").includes("Unknown /qa verify flag"));
  });
});
