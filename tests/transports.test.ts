import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  StdioMcpClient,
  StdioMcpError,
} from "../src/adapters/transports/stdio-mcp.js";

function server(): { command: string; args: string[] } {
  const root = path.resolve(import.meta.dirname, "..", "..");
  return {
    command: "node",
    args: [path.join(root, "fixtures", "mcp", "fake-server.mjs")],
  };
}

describe("StdioMcpClient", () => {
  it("handshakes, lists tools, calls echo with structured content", async () => {
    const s = server();
    const c = new StdioMcpClient({
      command: s.command,
      args: s.args,
      timeoutMs: 10_000,
    });
    await c.start();
    try {
      const tools = await c.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["echo", "boom"],
      );
      const out = await c.callTool<{ echo: { a: number } }>("echo", { a: 1 });
      assert.deepEqual(out, { echo: { a: 1 } });
    } finally {
      await c.stop();
    }
  });
  it("surfaces tool isError as an exception, never a fake result", async () => {
    const s = server();
    const c = new StdioMcpClient({
      command: s.command,
      args: s.args,
      timeoutMs: 10_000,
    });
    await c.start();
    try {
      await assert.rejects(() => c.callTool("boom", {}), /isError/);
    } finally {
      await c.stop();
    }
  });
  it("times out instead of hanging forever", async () => {
    const s = server();
    const c = new StdioMcpClient({
      command: s.command,
      args: s.args,
      timeoutMs: 500,
    });
    await c.start();
    try {
      await assert.rejects(() => c.callTool("silent", {}), StdioMcpError);
    } finally {
      await c.stop();
    }
  });
  it("non-JSON stdout is counted, not silently swallowed", async () => {
    const s = server();
    const c = new StdioMcpClient({
      command: s.command,
      args: s.args,
      timeoutMs: 10_000,
      env: { FAKE_MCP_NOISE: "1" },
    });
    await c.start();
    try {
      const out = await c.callTool<{ echo: unknown }>("echo", { a: 1 });
      assert.deepEqual(out, { echo: { a: 1 } });
      const notes = c.protocolNotes();
      assert.ok(notes.nonJsonLines >= 1, "expected protocol warnings");
      assert.ok(notes.sample.length > 0);
    } finally {
      await c.stop();
    }
  });
  it("missing binary is a clear startup error", async () => {
    const c = new StdioMcpClient({
      command: "definitely-not-a-server-zzz",
      timeoutMs: 2000,
    });
    await assert.rejects(() => c.start(), /failed to start|exited early/i);
    await c.stop();
  });
});
