import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  latestReceipt,
  loadReceipt,
  renderReceiptCompact,
  saveReceipt,
} from "../src/qa/receipt.js";
import type { QaReceipt } from "../src/qa/types.js";
import { cleanup, makeTempDir } from "./helpers.js";

function receipt(): QaReceipt {
  return {
    schema: "mattspi.qa.receipt.v1",
    id: "qa-test01",
    verdict: "FAIL",
    integrity: "OK",
    subject: {
      repo: "/tmp/r",
      branch: "main",
      base_sha: "abc",
      head_sha: "def123456789",
      remote: "origin",
      remote_sha: "zzz",
      remote_verified: false,
      dirty: true,
    },
    intent: { spec_id: "qa-spec-1", spec_revision: 1, satisfied: false },
    reuse: {
      searched: { text: "EXECUTED" },
      findings: ["same-repo: src/x.ts:3 matches 'foo'"],
    },
    verification: [
      { requirement_id: "A1", status: "violated", evidence_grade: "EXECUTED" },
    ],
    tests: { discovered: 1, executed: 1, passed: 0, failed: 2 },
    builder_claims: {
      supported: [],
      unsupported: ["tests pass"],
      contradicted: [],
      not_checked: [],
    },
    unknowns: ["remote SHA unreachable"],
    commands: [{ command: "npm test", exit_code: 1 }],
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

describe("receipt store", () => {
  it("save validates, load round-trips, latest works", () => {
    const dir = makeTempDir();
    try {
      assert.equal(latestReceipt(dir), null);
      const file = saveReceipt(dir, receipt());
      assert.ok(file.endsWith("qa-test01.json"));
      const loaded = loadReceipt(dir, "qa-test01");
      assert.equal(loaded.verdict, "FAIL");
      assert.equal(latestReceipt(dir)?.id, "qa-test01");
    } finally {
      cleanup(dir);
    }
  });
  it("refuses to save invalid receipts", () => {
    const dir = makeTempDir();
    try {
      const bad = receipt() as unknown as Record<string, unknown>;
      bad["verdict"] = "MAYBE";
      assert.throws(
        () => saveReceipt(dir, bad as unknown as QaReceipt),
        /invalid receipt/,
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("renderReceiptCompact", () => {
  it("emphasises verdict, SHA, failures, reuse, unknowns — not giant JSON", () => {
    const text = renderReceiptCompact(receipt());
    assert.ok(text.includes("FAIL"));
    assert.ok(text.includes("def123456789".slice(0, 12)));
    assert.ok(text.includes("A1"));
    assert.ok(text.includes("src/x.ts"));
    assert.ok(text.includes("remote SHA unreachable"));
    assert.ok(text.length < 3000);
    assert.ok(!text.includes('"evidence_grade"'));
  });
  it("adds the authority footer on STOP_RECOMMENDED", () => {
    const r = receipt();
    r.verdict = "STOP_RECOMMENDED";
    assert.ok(
      renderReceiptCompact(r).includes(
        "Tethers remains the authority boundary",
      ),
    );
  });
});
