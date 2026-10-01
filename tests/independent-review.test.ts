import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifierPrompt,
  extractFinalText,
  parseVerifierResult,
  runIndependentReview,
  type VerifierBundle,
} from "../src/qa/independent-review.js";

const bundle: VerifierBundle = {
  spec: { id: "qa-spec-1" },
  trustedRules: { ref: "abc", files: { "AGENTS.md": "rules" } },
  snapshot: { branch: "main" },
  diff: { files: ["a.ts"], text: "+ const a = 1;", truncated: false },
  testEvidence: { exit_code: 0 },
  reuseEvidence: {},
  lanternPack: {},
  agentPromptPath: "agents/verifier.md",
};

describe("buildVerifierPrompt", () => {
  it("throws when a builder report is supplied (withholding enforced)", () => {
    assert.throws(
      () => buildVerifierPrompt(bundle, "we did great"),
      /withhold/,
    );
  });
  it("builds a prompt containing spec and rules but no narrative slot", () => {
    const p = buildVerifierPrompt(bundle, null);
    assert.ok(p.includes("qa-spec-1"));
    assert.ok(p.includes("agents/verifier.md"));
    assert.ok(!p.includes("builder"));
  });
});

describe("extractFinalText", () => {
  it("takes the last assistant text from a pi json stream", () => {
    const stream = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"verdict":"PASS"}' }],
        },
      }),
    ].join("\n");
    assert.equal(extractFinalText(stream), '{"verdict":"PASS"}');
  });
  it("falls back to raw tail when no events parse", () => {
    assert.equal(extractFinalText("plain output").trim(), "plain output");
  });
});

describe("parseVerifierResult", () => {
  it("parses a verdict object embedded in prose", () => {
    const r = parseVerifierResult(
      'Here is my result: {"verdict":"FAIL","integrity":"OK","checks":[],"notes":["x"],"stopReasons":[],"integritySignals":[]} done.',
    );
    assert.equal(r.verdict, "FAIL");
    assert.deepEqual(r.notes, ["x"]);
  });
  it("throws on missing JSON", () => {
    assert.throws(() => parseVerifierResult("no json here"), /no JSON/);
  });
});

describe("runIndependentReview isolation", () => {
  it("uses a separate no-session process and withholds the narrative", async () => {
    let seenArgs: string[] = [];
    let seenInput = "";
    const fakeSpawn = async (args: string[], input: string) => {
      seenArgs = args;
      seenInput = input;
      const payload = JSON.stringify({
        verdict: "PASS",
        integrity: "OK",
        checks: [
          {
            requirement_id: "A1",
            status: "satisfied",
            evidence_grade: "EXECUTED",
          },
        ],
        notes: [],
        stopReasons: [],
        integritySignals: [],
      });
      const stream =
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: payload }],
          },
        }) + "\n";
      return { exitCode: 0, stdout: stream, stderr: "" };
    };
    const { result, spawnArgs } = await runIndependentReview("/tmp", bundle, {
      spawn: fakeSpawn,
    });
    assert.equal(result.verdict, "PASS");
    // Real spawn path proves: separate pi process, --no-session. Fake records the same arg contract.
    assert.deepEqual(spawnArgs, seenArgs);
    assert.ok(!seenInput.includes("builder"));
    assert.ok(seenInput.includes("qa-spec-1"));
  });
  it("verifier process failure becomes INCONCLUSIVE, never a pass", async () => {
    const { result } = await runIndependentReview("/tmp", bundle, {
      spawn: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "model auth missing",
      }),
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.integrity, "SUSPECT");
  });
  it("unparsable verifier output becomes INCONCLUSIVE", async () => {
    const { result } = await runIndependentReview("/tmp", bundle, {
      spawn: async () => ({
        exitCode: 0,
        stdout: "not json at all {{{",
        stderr: "",
      }),
    });
    assert.equal(result.verdict, "INCONCLUSIVE");
  });
});
