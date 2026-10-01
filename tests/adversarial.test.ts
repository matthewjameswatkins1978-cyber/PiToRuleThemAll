import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectDuplicateHelper,
  detectIgnoredBuiltin,
  detectPolicyChange,
  detectRejectedArchitecture,
  detectRemoteDivergence,
  detectUnexecutedTestClaim,
  detectUnnecessaryDependency,
  detectWeakenedTests,
} from "../src/qa/adversarial.js";
import { determineVerdict } from "../src/qa/verdict.js";
import { readFixtureJson } from "./helpers.js";

interface FixtureCase {
  id: string;
  title: string;
  diff?: string;
  newCode?: string;
  existingSnippet?: string;
  addedDeps?: string[];
  builtins?: { name: string; pattern: string }[];
  builderClaimsTestsPassed?: boolean;
  testCommandExecuted?: boolean;
  snapshot?: {
    dirty: boolean;
    headSha: string;
    remoteSha: string;
    ahead: number;
    behind: number;
    remote: string;
  };
  changedPolicyFiles?: string[];
  rejectedPaths?: string[];
  checks?: { requirement_id: string; status: string; evidence_grade: string }[];
  expected: Record<string, unknown>;
}

const cases = readFixtureJson(
  "fixtures/adversarial/cases.json",
) as FixtureCase[];

function runDetection(c: FixtureCase): { signal: string; detected: boolean }[] {
  const out: { signal: string; detected: boolean }[] = [];
  if (c.id === "test-weakened" || c.id === "good-implementation") {
    out.push(detectWeakenedTests(c.diff ?? ""));
  }
  if (c.addedDeps)
    out.push(detectUnnecessaryDependency(c.addedDeps, c.diff ?? ""));
  if (c.builtins) {
    out.push(
      detectIgnoredBuiltin(
        c.diff ?? "",
        c.builtins.map((b) => ({
          name: b.name,
          pattern: new RegExp(b.pattern),
        })),
      ),
    );
  }
  if (c.builderClaimsTestsPassed !== undefined) {
    out.push(
      detectUnexecutedTestClaim(
        c.builderClaimsTestsPassed,
        c.testCommandExecuted ?? false,
      ),
    );
  }
  if (c.snapshot) out.push(...detectRemoteDivergence(c.snapshot));
  if (c.changedPolicyFiles) out.push(detectPolicyChange(c.changedPolicyFiles));
  if (c.rejectedPaths)
    out.push(detectRejectedArchitecture(c.diff ?? "", c.rejectedPaths));
  if (c.existingSnippet && c.newCode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-adv-"));
    const f = path.join(dir, "existing.ts");
    fs.writeFileSync(f, c.existingSnippet, "utf-8");
    out.push(detectDuplicateHelper(c.newCode, [f]));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

describe("adversarial fixtures", () => {
  for (const c of cases) {
    it(`${c.id}: ${c.title}`, async () => {
      const expected = c.expected;
      if (c.id === "restart-failure") {
        // Behavioural probe, not a static pattern: write → destroy → read → compare.
        const { restartProbe } = await import("../src/qa/adversarial.js");
        const d = await restartProbe({
          workDir: os.tmpdir(),
          expected: { persisted: true },
          write: async () => {},
          read: async () => ({ persisted: false }),
        });
        assert.equal(d.signal, expected["signal"]);
        assert.equal(d.detected, expected["detected"]);
        return;
      }
      if (c.checks) {
        // Verdict-level fixtures
        const { verdict } = determineVerdict({
          checks: c.checks.map((x) => ({
            requirement_id: x.requirement_id,
            status: x.status as "satisfied",
            evidence_grade: x.evidence_grade as "EXECUTED",
          })),
        });
        assert.equal(
          verdict,
          expected["verdict"],
          `${c.id}: expected verdict ${expected["verdict"]}, got ${verdict}`,
        );
        return;
      }
      const detections = runDetection(c);
      const want = expected["signal"] as string;
      const hit = detections.find((d) => d.signal === want);
      assert.ok(
        hit,
        `${c.id}: no detection produced for signal '${want}' (got ${detections.map((d) => d.signal).join(",")})`,
      );
      assert.equal(
        hit.detected,
        expected["detected"],
        `${c.id}: signal '${want}' detected=${hit.detected}, expected ${expected["detected"]}`,
      );
    });
  }

  it("mentioning skip-patterns in strings is not weakening (fixture self-reference)", () => {
    const w = detectWeakenedTests(
      "const patterns = [/\\.skip\\(/, /xit\\(/]; // detector self-test",
    );
    assert.equal(w.detected, false);
  });
  it("real skip calls still detected after quote stripping", () => {
    const w = detectWeakenedTests(
      "+ test.skip('loads config', () => {\\n+ });",
    );
    assert.equal(w.detected, true);
  });
  it("good implementation produces no detections (false-positive guard)", () => {
    const good = cases.find((c) => c.id === "good-implementation")!;
    const d = runDetection({
      ...good,
      addedDeps: [],
      builtins: [],
      changedPolicyFiles: [],
      rejectedPaths: [],
    });
    // weakened-test detector on the good diff must stay quiet
    const w = detectWeakenedTests(good.diff ?? "");
    assert.equal(w.detected, false);
    void d;
  });

  it("restart-failure fixture: probe detects mismatch (simulated)", async () => {
    const { restartProbe } = await import("../src/qa/adversarial.js");
    const d = await restartProbe({
      workDir: os.tmpdir(),
      expected: { v: 1 },
      write: async () => {},
      read: async () => ({ v: 2 }),
    });
    assert.equal(d.signal, "restart-persistence");
    assert.equal(d.detected, true);
  });

  it("every fixture class documents an expectation", () => {
    const ids = cases.map((c) => c.id);
    for (const want of [
      "duplicate-helper",
      "unnecessary-dependency",
      "builtin-ignored",
      "test-weakened",
      "tests-not-executed",
      "false-pass-claim",
      "restart-failure",
      "uncommitted-work",
      "head-differs-remote",
      "qa-rules-changed",
      "rejected-architecture",
      "missing-evidence",
      "good-implementation",
    ]) {
      assert.ok(ids.includes(want), `missing fixture class: ${want}`);
    }
  });
});
