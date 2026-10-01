import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findLanternTools,
  registerQaExtension,
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
    getAllTools: () => [
      { name: "read" },
      { name: "mcp__lantern__lantern_context" },
      { name: "mcp__lantern__lantern_why" },
    ],
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

describe("findLanternTools", () => {
  it("matches lantern tools across naming conventions", () => {
    const found = findLanternTools([
      { name: "read" },
      { name: "mcp__lantern__lantern_context" },
      { name: "lantern_remember" },
    ]);
    assert.deepEqual(found, [
      "mcp__lantern__lantern_context",
      "lantern_remember",
    ]);
  });
  it("empty when Lantern is not connected", () => {
    assert.deepEqual(findLanternTools([{ name: "read" }]), []);
  });
});

describe("/keeper status", () => {
  it("reports CONNECTED when tools are visible", async () => {
    const { pi, commands } = fakePi();
    registerQaExtension(pi);
    const { ctx, seen } = fakeCtx();
    await commands.get("keeper")!("status", ctx);
    assert.ok(seen.join("\n").includes("CONNECTED"));
  });
  it("reports UNAVAILABLE honestly when nothing is connected", async () => {
    const { pi, commands } = fakePi();
    pi.getAllTools = () => [{ name: "read" }];
    registerQaExtension(pi);
    const { ctx, seen } = fakeCtx();
    await commands.get("keeper")!("status", ctx);
    assert.ok(seen.join("\n").includes("UNAVAILABLE"));
  });
});

describe("/qa help", () => {
  it("lists the three subcommands", async () => {
    const { pi, commands } = fakePi();
    registerQaExtension(pi);
    const { ctx, seen } = fakeCtx();
    await commands.get("qa")!("help", ctx);
    const out = seen.join("\n");
    assert.ok(
      out.includes("preflight") &&
        out.includes("verify") &&
        out.includes("receipt"),
    );
  });
});

describe("toolContextLanternCaller", () => {
  it("routes short names to full MCP tool names and parses JSON", async () => {
    const toolCtx = {
      cwd: "/tmp",
      ui: { notify: () => {}, confirm: async () => true },
      tools: [{ name: "mcp__lantern__lantern_context" }],
      executeTool: async (name: string) => ({
        result: {
          content: [{ type: "text", text: JSON.stringify({ id: "pack-1" }) }],
        },
        isError: false,
      }),
    };
    const caller = toolContextLanternCaller(
      ["mcp__lantern__lantern_context"],
      toolCtx,
    );
    const r = await caller.call("lantern_context", { query: "x" });
    assert.equal(r.ok, true);
    assert.equal((r.data as { id: string }).id, "pack-1");
    const missing = await caller.call("lantern_why", {});
    assert.equal(missing.ok, false);
  });
});
