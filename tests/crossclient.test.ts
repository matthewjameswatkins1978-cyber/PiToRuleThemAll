import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LanternClient } from "../src/adapters/lantern.js";
import {
  buildReceipt,
  completeReceipt,
  createProof,
  loadReceipt,
  proofMarker,
  renderHandoff,
  saveReceipt,
  validateCrossClientReceipt,
  verifyCrossClientMatch,
} from "../src/crossclient/proof.js";

function fakeCaller() {
  return {
    call: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "lantern_remember") {
        assert.equal(args["kind"], "reference");
        assert.ok(
          typeof args["content"] === "string" && args["content"].length > 0,
        );
        return {
          ok: true,
          data: { memory_item: { id: "mem-1", kind: "reference" } },
        };
      }
      if (tool === "lantern_search") {
        return {
          ok: true,
          data: {
            memory_items: [{ id: "mem-1", kind: "reference", content: "x" }],
          },
        };
      }
      if (tool === "lantern_why") {
        assert.deepEqual(args, { memory_id: "mem-1" });
        return {
          ok: true,
          data: {
            memory_item: { id: "mem-1" },
            provenance: {
              originator_actor_id: "matthew",
              holder_actor_id: "matthew",
            },
          },
        };
      }
      return { ok: false, error: `unexpected ${tool}` };
    },
  };
}

describe("proofMarker", () => {
  it("is unique per invocation", () => {
    const a = proofMarker(new Date("2026-10-01T00:00:01Z"));
    const b = proofMarker(new Date("2026-10-01T00:00:02Z"));
    assert.ok(a.startsWith("pi-crossclient-"));
    assert.notEqual(a, b);
  });
});

describe("createProof", () => {
  it("creates one reference marker with captured ID and provenance", async () => {
    const client = new LanternClient(fakeCaller());
    const proof = await createProof(client, {
      project: "PiToRuleThemAll",
      sha: "abc123",
      reconnect: async () => ({
        client: new LanternClient(fakeCaller()),
        close: async () => {},
      }),
    });
    assert.ok(proof.marker.startsWith("pi-crossclient-"));
    assert.equal(proof.memoryId, "mem-1");
    assert.equal(proof.kind, "reference");
    assert.ok(proof.content.includes(proof.marker));
    assert.ok(proof.provenance.some((t) => t.startsWith("memory:mem-1")));
  });
  it("throws instead of storing a partial proof", async () => {
    const client = new LanternClient({
      call: async () => ({ ok: false as const, error: "down" }),
    });
    await assert.rejects(() =>
      createProof(client, {
        project: "p",
        sha: "s",
        reconnect: async () => null,
      }),
    );
  });
});

describe("cross-client receipt", () => {
  function pending() {
    return buildReceipt(
      {
        marker: "pi-crossclient-20261001-000000",
        memoryId: "mem-1",
        kind: "reference",
        content: "content",
        provenance: [
          "memory:mem-1",
          "originator_actor_id:matthew",
          "holder_actor_id:matthew",
        ],
        grades: {
          remember: "EXECUTED",
          search: "EXECUTED",
          why: "EXECUTED",
          postRestart: "EXECUTED",
        },
      },
      { repo: "/tmp/r", sha: "abc" },
    );
  }
  it("starts PENDING with chatgpt unobserved", () => {
    const r = pending();
    assert.equal(r.schema, "mattspi.crossclient.v1");
    assert.equal(r.chatgpt.observed, false);
    assert.equal(r.chatgpt.status, "PENDING");
    assert.deepEqual(validateCrossClientReceipt(r), { ok: true, receipt: r });
  });
  it("observed=true requires VERIFIED", () => {
    const bad = {
      ...pending(),
      chatgpt: { observed: true, status: "PENDING" },
    };
    const v = validateCrossClientReceipt(bad);
    assert.equal(v.ok, false);
  });
  it("handoff contains exact marker and memory ID", () => {
    const h = renderHandoff(pending());
    assert.ok(h.includes("pi-crossclient-20261001-000000"));
    assert.ok(h.includes("mem-1"));
  });
  it("matching Lucy evidence verifies", () => {
    const v = verifyCrossClientMatch(pending(), {
      marker: "pi-crossclient-20261001-000000",
      memory_id: "mem-1",
      kind: "reference",
      originator_actor_id: "matthew",
      holder_actor_id: "matthew",
    });
    assert.equal(v.verified, true);
    assert.deepEqual(v.mismatches, []);
  });
  it("same text with a different ID is rejected (copying, not sharing)", () => {
    const v = verifyCrossClientMatch(pending(), {
      marker: "pi-crossclient-20261001-000000",
      memory_id: "mem-OTHER",
      kind: "reference",
      originator_actor_id: "matthew",
      holder_actor_id: "matthew",
    });
    assert.equal(v.verified, false);
    assert.ok(
      v.mismatches.some((m) => m.includes("copying, not shared storage")),
    );
  });
  it("mismatched provenance is rejected", () => {
    const v = verifyCrossClientMatch(pending(), {
      marker: "pi-crossclient-20261001-000000",
      memory_id: "mem-1",
      kind: "reference",
      originator_actor_id: "someone-else",
      holder_actor_id: "matthew",
    });
    assert.equal(v.verified, false);
  });
  it("completion supersedes without rewriting history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-cc-"));
    try {
      const first = saveReceipt(dir, pending());
      assert.ok(fs.existsSync(first));
      const done = completeReceipt(pending(), {
        marker: "pi-crossclient-20261001-000000",
        memory_id: "mem-1",
        kind: "reference",
        originator_actor_id: "matthew",
        holder_actor_id: "matthew",
      });
      assert.equal(done.chatgpt.status, "VERIFIED");
      const second = saveReceipt(dir, {
        ...done,
        created_at: "2026-10-02T00:00:00.000Z",
      });
      assert.notEqual(first, second);
      assert.ok(fs.existsSync(first), "original PENDING receipt still on disk");
      assert.equal(
        loadReceipt(dir, "pi-crossclient-20261001-000000", "VERIFIED").chatgpt
          .status,
        "VERIFIED",
      );
      assert.equal(
        loadReceipt(dir, "pi-crossclient-20261001-000000", "PENDING").chatgpt
          .status,
        "PENDING",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
