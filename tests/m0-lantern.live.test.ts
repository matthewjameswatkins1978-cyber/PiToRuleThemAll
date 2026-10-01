/**
 * M0 LIVE Lantern proof (defect A/D). This test actually calls Lantern:
 * stdio MCP bridge (the real `lighting mcp` binary) against the real
 * local service. No fakes on this path — a fake adapter cannot satisfy M0.
 *
 * Gate: skipped unless PI_QA_LIVE_LANTERN=1. Prerequisites:
 *   - bridge binary: PI_QA_LANTERN_BIN or
 *     D:\Projects\lantern-keeper\target\debug\lighting.exe
 *   - service: PI_QA_LANTERN_URL or http://127.0.0.1:4317 (serve running)
 *
 * The marker is a valid `reference` soft memory and is INTENTIONALLY
 * left in place: Lucy needs it for the ChatGPT-side cross-client check.
 * Proof artifacts (marker, memory_id, per-step grades) are written to
 * .pi/qa/m0-proof-<stamp>.json for the final report.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LanternClient, type LanternCaller } from "../src/adapters/lantern.js";
import { StdioMcpClient } from "../src/adapters/transports/stdio-mcp.js";

const LIVE = process.env["PI_QA_LIVE_LANTERN"] === "1";
const BIN = process.env["PI_QA_LANTERN_BIN"] ?? "D:\\Projects\\lantern-keeper\\target\\debug\\lighting.exe";
const URL = process.env["PI_QA_LANTERN_URL"] ?? "http://127.0.0.1:4317";

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

async function openCaller(): Promise<{ caller: LanternCaller; close(): Promise<void> }> {
  const client = new StdioMcpClient({ command: BIN, args: ["mcp"], env: { LIGHTING_SERVICE_URL: URL }, timeoutMs: 60_000 });
  await client.start();
  return {
    caller: {
      call: async (tool, args) => {
        try {
          return { ok: true, data: await client.callTool(tool, args) };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    close: () => client.stop(),
  };
}

describe("M0 live Lantern connectivity", { skip: !LIVE }, () => {
  it("status → remember → search → why → reconnect → search, all EXECUTED", async () => {
    assert.ok(fs.existsSync(BIN), `bridge binary missing: ${BIN}`);
    const first = await openCaller();
    const client = new LanternClient(first.caller);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const marker = `pi-qa-m0-${stamp}`;
    const content = `Pi QA M0 marker ${marker} (repair R1 proof; safe to archive)`;
    let proof;
    try {
      proof = await client.connectivityProof({
        marker,
        content,
        reconnect: async () => {
          const fresh = await openCaller();
          return { client: new LanternClient(fresh.caller), close: fresh.close };
        },
      });
    } finally {
      await first.close();
    }
    const dir = path.join(repoRoot(), ".pi", "qa");
    fs.mkdirSync(dir, { recursive: true });
    const artifact = path.join(dir, `m0-proof-${stamp}.json`);
    fs.writeFileSync(artifact, JSON.stringify({ marker, content, proof }, null, 2) + "\n", "utf-8");
    console.log(`M0 artifact: ${artifact}`);
    for (const s of proof.steps) {
      assert.equal(s.grade, "EXECUTED", `step ${s.name}: ${s.detail}`);
    }
    assert.equal(proof.passed, true);
    assert.ok(proof.memoryId, "memory_id stored");
  });
});

describe("M0 proof honesty guard", () => {
  it("null caller cannot fake a PASS", async () => {
    const c = new LanternClient(null);
    const proof = await c.connectivityProof({
      marker: "nope",
      content: "nope",
      reconnect: async () => null,
    });
    assert.equal(proof.passed, false);
    assert.ok(proof.steps.every((s) => s.grade !== "EXECUTED"));
  });
});
