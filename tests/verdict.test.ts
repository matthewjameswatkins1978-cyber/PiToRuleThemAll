import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBuilderClaim,
  determineIntegrity,
  determineVerdict,
  evaluateTamper,
  maxIntegrity,
} from "../src/qa/verdict.js";
import type { RequirementCheck } from "../src/qa/types.js";

const sat = (
  id: string,
  grade: RequirementCheck["evidence_grade"] = "EXECUTED",
): RequirementCheck => ({
  requirement_id: id,
  status: "satisfied",
  evidence_grade: grade,
});

describe("determineVerdict", () => {
  it("PASS when all satisfied with strong evidence", () => {
    const r = determineVerdict({ checks: [sat("A1"), sat("A2", "OBSERVED")] });
    assert.equal(r.verdict, "PASS");
  });
  it("PASS_WITH_NOTES when notes exist", () => {
    const r = determineVerdict({ checks: [sat("A1")], notes: ["minor nit"] });
    assert.equal(r.verdict, "PASS_WITH_NOTES");
  });
  it("FAIL on any violated check", () => {
    const r = determineVerdict({
      checks: [
        sat("A1"),
        {
          requirement_id: "A2",
          status: "violated",
          evidence_grade: "EXECUTED",
        },
      ],
    });
    assert.equal(r.verdict, "FAIL");
  });
  it("INCONCLUSIVE on unverified", () => {
    const r = determineVerdict({
      checks: [
        sat("A1"),
        {
          requirement_id: "A2",
          status: "unverified",
          evidence_grade: "UNAVAILABLE",
        },
      ],
    });
    assert.equal(r.verdict, "INCONCLUSIVE");
  });
  it("STOP_RECOMMENDED takes precedence over FAIL", () => {
    const r = determineVerdict({
      checks: [
        {
          requirement_id: "A1",
          status: "violated",
          evidence_grade: "EXECUTED",
        },
      ],
      stopReasons: ["would delete production data"],
    });
    assert.equal(r.verdict, "STOP_RECOMMENDED");
  });
  it("downgrades REPORTED-only important PASS to INCONCLUSIVE", () => {
    const r = determineVerdict({ checks: [sat("A1", "REPORTED")] });
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.deepEqual(r.downgraded, ["A1"]);
    assert.equal(r.effectiveChecks[0]?.status, "unverified");
  });
  it("does not downgrade REPORTED on unimportant checks", () => {
    const r = determineVerdict({
      checks: [sat("A1", "REPORTED")],
      important: [],
    });
    assert.equal(r.verdict, "PASS");
  });
  it("INFERRED is also weak for important checks", () => {
    const r = determineVerdict({ checks: [sat("A1", "INFERRED")] });
    assert.equal(r.verdict, "INCONCLUSIVE");
  });
});

describe("determineIntegrity", () => {
  it("OK by default", () => {
    assert.equal(determineIntegrity([]), "OK");
  });
  it("SUSPECT on altered environment", () => {
    assert.equal(
      determineIntegrity(["worktree altered during verify"]),
      "SUSPECT",
    );
  });
  it("COMPROMISED on tampering", () => {
    assert.equal(
      determineIntegrity(["reviewer attempted to defeat verification"]),
      "COMPROMISED",
    );
  });
});

describe("maxIntegrity", () => {
  it("never downgrades: COMPROMISED survives", () => {
    assert.equal(maxIntegrity("OK", "COMPROMISED", "OK"), "COMPROMISED");
    assert.equal(maxIntegrity("COMPROMISED"), "COMPROMISED");
    assert.equal(maxIntegrity("OK", null, undefined), "OK");
    assert.equal(maxIntegrity("SUSPECT", "OK"), "SUSPECT");
  });
});

describe("evaluateTamper", () => {
  it("policy change alone is risk, not stop", () => {
    const r = evaluateTamper({
      policyChanged: ["AGENTS.md"],
      harnessChanged: [],
      testWeakened: false,
      testsClaimedButNotExecuted: false,
    });
    assert.equal(r.integrity, "OK");
    assert.deepEqual(r.stopReasons, []);
    assert.ok(r.risks.length > 0);
  });
  it("harness change alone is SUSPECT", () => {
    const r = evaluateTamper({
      policyChanged: [],
      harnessChanged: ["src/qa/verify.ts"],
      testWeakened: false,
      testsClaimedButNotExecuted: false,
    });
    assert.equal(r.integrity, "SUSPECT");
    assert.deepEqual(r.stopReasons, []);
  });
  it("harness change + weakened tests is COMPROMISED + STOP", () => {
    const r = evaluateTamper({
      policyChanged: [],
      harnessChanged: ["src/qa/verify.ts"],
      testWeakened: true,
      testsClaimedButNotExecuted: false,
    });
    assert.equal(r.integrity, "COMPROMISED");
    assert.equal(r.stopReasons.length, 1);
  });
});

describe("classifyBuilderClaim", () => {
  it("SUPPORTED with executed evidence", () => {
    assert.equal(
      classifyBuilderClaim({
        claim: "tests pass",
        evidenceGrade: "EXECUTED",
        contradictsEvidence: false,
      }),
      "SUPPORTED",
    );
  });
  it("UNSUPPORTED with reported-only evidence", () => {
    assert.equal(
      classifyBuilderClaim({
        claim: "tests pass",
        evidenceGrade: "REPORTED",
        contradictsEvidence: false,
      }),
      "UNSUPPORTED",
    );
  });
  it("CONTRADICTED beats everything", () => {
    assert.equal(
      classifyBuilderClaim({
        claim: "x",
        evidenceGrade: "EXECUTED",
        contradictsEvidence: true,
      }),
      "CONTRADICTED",
    );
  });
  it("NOT_CHECKED with no evidence", () => {
    assert.equal(
      classifyBuilderClaim({
        claim: "x",
        evidenceGrade: null,
        contradictsEvidence: false,
      }),
      "NOT_CHECKED",
    );
  });
});
