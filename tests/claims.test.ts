import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileBuilderClaims } from "../src/qa/claims.js";
import type { ObservedEvidence } from "../src/qa/claims.js";

const base: ObservedEvidence = {
  testsExecuted: true,
  testsPassed: 127,
  testsFailed: 0,
  testsExitCode: 0,
  formatExitCode: 0,
  typecheckExitCode: 0,
  dirty: false,
  branch: "main",
  headSha: "abcdef1234567890",
  remoteSha: "abcdef1234567890",
  remoteVerified: true,
  filesChanged: ["a.ts", "b.ts"],
  extensionLoaded: true,
  commandsExecuted: [{ command: "npm test", exit_code: 0 }],
};

function one(report: string, ev: ObservedEvidence = base) {
  const out = reconcileBuilderClaims(report, ev);
  assert.equal(out.length, 1);
  return out[0]!;
}

describe("reconcileBuilderClaims", () => {
  it("127 tests passed + 127 observed → SUPPORTED", () => {
    const r = one("127 tests passed");
    assert.equal(r.classification, "SUPPORTED");
  });
  it("120 tests passed + 127 observed → CONTRADICTED", () => {
    const r = one("120 tests passed");
    assert.equal(r.classification, "CONTRADICTED");
  });
  it("tests passed with no QA execution → UNSUPPORTED", () => {
    const r = one("tests passed", { ...base, testsExecuted: false, testsExitCode: null });
    assert.equal(r.classification, "UNSUPPORTED");
  });
  it("tests passed + failing QA run → CONTRADICTED", () => {
    const r = one("tests pass", { ...base, testsFailed: 2, testsExitCode: 1 });
    assert.equal(r.classification, "CONTRADICTED");
  });
  it("format passed + exit 0 → SUPPORTED; exit 1 → CONTRADICTED", () => {
    assert.equal(one("format passed").classification, "SUPPORTED");
    assert.equal(one("format clean", { ...base, formatExitCode: 1 }).classification, "CONTRADICTED");
  });
  it("typecheck passed → SUPPORTED", () => {
    assert.equal(one("typecheck passed").classification, "SUPPORTED");
  });
  it("tree clean on clean tree → SUPPORTED; on dirty → CONTRADICTED", () => {
    assert.equal(one("tree clean").classification, "SUPPORTED");
    assert.equal(one("tree clean", { ...base, dirty: true }).classification, "CONTRADICTED");
  });
  it("branch main → SUPPORTED; branch other → CONTRADICTED", () => {
    assert.equal(one("on branch main").classification, "SUPPORTED");
    assert.equal(one("on branch feature").classification, "CONTRADICTED");
  });
  it("matching SHA → SUPPORTED; wrong SHA → CONTRADICTED", () => {
    assert.equal(one("HEAD abcdef1").classification, "SUPPORTED");
    assert.equal(one("HEAD 0000000").classification, "CONTRADICTED");
  });
  it("pushed + remote verified → SUPPORTED; diverged → CONTRADICTED", () => {
    assert.equal(one("pushed").classification, "SUPPORTED");
    assert.equal(
      one("pushed", { ...base, remoteSha: "zzz", remoteVerified: false }).classification,
      "CONTRADICTED",
    );
  });
  it("2 files changed + 2 in diff → SUPPORTED; 5 → CONTRADICTED", () => {
    assert.equal(one("2 files changed").classification, "SUPPORTED");
    assert.equal(one("5 files changed").classification, "CONTRADICTED");
  });
  it("extension loaded → SUPPORTED when observed", () => {
    assert.equal(one("extension loaded").classification, "SUPPORTED");
  });
  it("ran `npm test` + exit 0 → SUPPORTED", () => {
    assert.equal(one("ran `npm test`").classification, "SUPPORTED");
  });
  it("semantic claims stay NOT_CHECKED", () => {
    assert.equal(one("cross-platform behaviour proven").classification, "NOT_CHECKED");
    assert.equal(one("production ready").classification, "NOT_CHECKED");
  });
});
