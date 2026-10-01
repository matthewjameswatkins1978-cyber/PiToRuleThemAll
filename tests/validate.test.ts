import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateReceipt, validateSpec } from "../src/qa/validate.js";

const goodSpec = {
  schema: "mattspi.qa.spec.v1",
  id: "qa-spec-abc123",
  created_at: "2026-10-01T00:00:00.000Z",
  task: { raw_request: "do X", normalized_intent: "do X" },
  acceptance: [{ id: "A1", requirement: "X works" }],
  project: { repo_root: "/tmp/r", branch: "main", base_sha: "abc" },
  revision: 1,
};

const goodReceipt = {
  schema: "mattspi.qa.receipt.v1",
  id: "qa-abc123",
  verdict: "PASS",
  integrity: "OK",
  subject: {
    repo: "/tmp/r",
    branch: "main",
    base_sha: "abc",
    head_sha: "def",
    remote_verified: false,
  },
  intent: { spec_id: "qa-spec-abc123", spec_revision: 1, satisfied: true },
  verification: [
    { requirement_id: "A1", status: "satisfied", evidence_grade: "EXECUTED" },
  ],
  tests: { discovered: 1, executed: 1, passed: 1, failed: 0 },
  created_at: "2026-10-01T00:00:00.000Z",
};

describe("validateSpec", () => {
  it("accepts a minimal valid spec", () => {
    const r = validateSpec(goodSpec);
    assert.equal(r.ok, true);
  });
  it("rejects wrong schema const", () => {
    const r = validateSpec({ ...goodSpec, schema: "other" });
    assert.equal(r.ok, false);
  });
  it("rejects empty acceptance", () => {
    const r = validateSpec({ ...goodSpec, acceptance: [] });
    assert.equal(r.ok, false);
  });
  it("rejects bad acceptance ids", () => {
    const r = validateSpec({
      ...goodSpec,
      acceptance: [{ id: "X", requirement: "y" }],
    });
    assert.equal(r.ok, false);
  });
  it("rejects unknown fields (frozen contract)", () => {
    const r = validateSpec({ ...goodSpec, hacked: true });
    assert.equal(r.ok, false);
  });
  it("rejects revision 0", () => {
    const r = validateSpec({ ...goodSpec, revision: 0 });
    assert.equal(r.ok, false);
  });
  it("rejects non-objects", () => {
    assert.equal(validateSpec(null).ok, false);
    assert.equal(validateSpec("x").ok, false);
  });
});

describe("validateReceipt", () => {
  it("accepts a minimal valid receipt", () => {
    const r = validateReceipt(goodReceipt);
    assert.equal(r.ok, true);
  });
  it("rejects unknown verdicts", () => {
    const r = validateReceipt({ ...goodReceipt, verdict: "MAYBE" });
    assert.equal(r.ok, false);
  });
  it("rejects unknown evidence grades", () => {
    const r = validateReceipt({
      ...goodReceipt,
      verification: [
        { requirement_id: "A1", status: "satisfied", evidence_grade: "VIBES" },
      ],
    });
    assert.equal(r.ok, false);
  });
  it("rejects negative test counts", () => {
    const r = validateReceipt({
      ...goodReceipt,
      tests: { discovered: -1, executed: 0, passed: 0, failed: 0 },
    });
    assert.equal(r.ok, false);
  });
  it("rejects unknown fields", () => {
    const r = validateReceipt({ ...goodReceipt, secrets: { token: "x" } });
    assert.equal(r.ok, false);
  });
});
