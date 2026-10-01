/**
 * /qa verify (M2). Pipeline:
 *
 *   freeze reality → load frozen spec → load trusted rules →
 *   deterministic evidence → reuse check → Lantern pack →
 *   fresh independent reviewer → optional Telltail →
 *   compare builder claims (only now) → receipt → store.
 *
 * The frozen spec cannot silently mutate: verify re-validates the spec
 * file and pins spec_id + revision on the receipt. Builder claims are
 * classified SUPPORTED/UNSUPPORTED/CONTRADICTED/NOT_CHECKED after the
 * verifier's initial result.
 */

import { randomUUID } from "node:crypto";
import { LanternClient } from "../adapters/lantern.js";
import { ReuseryClient } from "../adapters/reusery.js";
import { TelltailClient } from "../adapters/telltail.js";
import { TethersClient } from "../adapters/tethers.js";
import {
  boundedDiff,
  changedPolicyFiles,
  readAtRef,
  snapshotGit,
} from "../evidence/git.js";
import { runTests } from "../evidence/tests.js";
import { resolveReuse } from "../reuse/resolver.js";
import {
  detectPolicyChange,
  detectRejectedArchitecture,
  detectRemoteDivergence,
  detectUnexecutedTestClaim,
  detectUnnecessaryDependency,
  detectWeakenedTests,
  type Detection,
} from "./adversarial.js";
import {
  buildVerifierPrompt,
  runIndependentReview,
  type SpawnFn,
  type VerifierBundle,
} from "./independent-review.js";
import { saveReceipt } from "./receipt.js";
import { latestSpec, loadSpec } from "./spec.js";
import type { BuilderClaim } from "./verdict.js";
import {
  classifyBuilderClaim,
  determineIntegrity,
  determineVerdict,
} from "./verdict.js";
import type { EvidenceGrade, QaReceipt, RequirementCheck } from "./types.js";

export interface VerifyOptions {
  specId?: string;
  /** Builder completion narrative. Withheld from the verifier until its initial result. */
  builderReport?: string | null;
  builderClaimsTestsPassed?: boolean;
  addedDependencies?: string[];
  requireRemotePush?: boolean;
  agentPromptPath?: string;
  spawn?: SpawnFn;
  focusFile?: string;
  siblingRepos?: string[];
}

export interface VerifyOutcome {
  receipt: QaReceipt;
  receiptFile: string;
  verifierSpawnArgs: string[];
  detections: Detection[];
  promptWithheld: boolean;
}

export async function verify(
  repoRoot: string,
  deps: {
    lantern: LanternClient;
    reusery: ReuseryClient;
    telltail: TelltailClient;
    tethers: TethersClient;
  },
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const spec = opts.specId
    ? loadSpec(repoRoot, opts.specId)
    : latestSpec(repoRoot);
  if (!spec) throw new Error("no QA spec found. Run /qa preflight first.");

  // 1. Freeze reality.
  const snapshot = await snapshotGit(repoRoot);

  // 2. Trusted rules from the base ref, never from the branch under review.
  const baseRef = snapshot.baseSha ?? "HEAD";
  const trustedRules: Record<string, string | null> = {};
  for (const f of ["AGENTS.md", "package.json"]) {
    trustedRules[f] = snapshot.isRepo
      ? await readAtRef(repoRoot, baseRef, f)
      : null;
  }

  // 3. Deterministic evidence.
  const diff =
    snapshot.isRepo && snapshot.baseSha && snapshot.headSha
      ? await boundedDiff(repoRoot, snapshot.baseSha, snapshot.headSha)
      : { diff: "", truncated: false, files: [] as string[] };
  const tests = await runTests(repoRoot);
  const testEvidence = {
    discovered: tests.discovered,
    command: tests.command,
    exit_code: tests.result?.exitCode ?? null,
    passed: tests.passed,
    failed: tests.failed,
    grade: (tests.discovered && tests.result
      ? "EXECUTED"
      : "UNAVAILABLE") as EvidenceGrade,
  };

  // 4. Reuse check.
  const lanternPack = await deps.lantern.context(spec.task.normalized_intent);
  const reusery = await deps.reusery.query(spec.task.normalized_intent);
  const reuse = await resolveReuse(repoRoot, spec.task.normalized_intent, {
    focusFile: opts.focusFile,
    siblingRepos: opts.siblingRepos,
    lanternGrade: lanternPack.grade,
    reuseryGrade: reusery.grade,
  });
  if (reusery.grade !== "UNAVAILABLE") {
    reuse.found.push(
      `reusery: ${reusery.outcome} ${reusery.candidates.slice(0, 3).join(", ")}`.trim(),
    );
  }

  // 5. Adversarial detectors (deterministic, pre-verifier).
  const detections: Detection[] = [];
  detections.push(detectWeakenedTests(diff.diff));
  detections.push(
    detectUnexecutedTestClaim(
      opts.builderClaimsTestsPassed ?? false,
      testEvidence.grade === "EXECUTED",
    ),
  );
  detections.push(
    detectUnnecessaryDependency(opts.addedDependencies ?? [], diff.diff),
  );
  detections.push(
    detectPolicyChange(
      snapshot.isRepo && snapshot.baseSha && snapshot.headSha
        ? await changedPolicyFiles(repoRoot, snapshot.baseSha, snapshot.headSha)
        : [],
    ),
  );
  detections.push(
    detectRejectedArchitecture(diff.diff, lanternPack.pack.rejectedPaths),
  );
  if (snapshot.isRepo) {
    detections.push(
      ...detectRemoteDivergence({
        dirty: snapshot.dirty,
        headSha: snapshot.headSha,
        remoteSha: snapshot.remoteSha,
        ahead: snapshot.ahead,
        behind: snapshot.behind,
        remote: snapshot.remote,
      }),
    );
  }

  // 6. Independent reviewer (builder report withheld by construction).
  const bundle: VerifierBundle = {
    spec,
    trustedRules: { ref: baseRef, files: trustedRules },
    snapshot,
    diff: { files: diff.files, text: diff.diff, truncated: diff.truncated },
    testEvidence,
    reuseEvidence: reuse,
    lanternPack: lanternPack.pack,
    agentPromptPath: opts.agentPromptPath ?? "agents/verifier.md",
  };
  // Prove the boundary: building the prompt with a report must throw.
  let promptWithheld = false;
  try {
    buildVerifierPrompt(bundle, opts.builderReport ?? "SENTINEL");
    promptWithheld = false;
  } catch {
    promptWithheld = true;
  }
  const { result: initial, spawnArgs } = await runIndependentReview(
    repoRoot,
    bundle,
    { spawn: opts.spawn },
  );

  // 7. Optional Telltail behavioural evidence.
  const unknowns: string[] = [];
  const risks: string[] = [];
  const telltail = await deps.telltail.evaluate("qa-behavioural", {
    spec_id: spec.id,
    verdict: initial.verdict,
  });
  if (telltail.grade === "UNAVAILABLE")
    unknowns.push(`telltail: ${telltail.note}`);
  if (lanternPack.grade === "UNAVAILABLE")
    unknowns.push(`lantern: ${lanternPack.note}`);
  if (
    reusery.grade === "UNAVAILABLE" &&
    reusery.outcome === "NEEDS_VERIFICATION"
  )
    unknowns.push(`reusery: ${reusery.note}`);
  if (testEvidence.grade === "UNAVAILABLE")
    unknowns.push("tests: no recognised harness or execution failed");
  if (diff.truncated)
    unknowns.push(
      "diff truncated at 40k chars: unshown files marked not_checked by verifier",
    );

  // 8. Fold detections into checks: hard signals become violated/unverified.
  const checks: RequirementCheck[] = initial.checks.map((c) => ({
    requirement_id: c.requirement_id,
    status: c.status as RequirementCheck["status"],
    evidence_grade: c.evidence_grade,
    evidence: c.evidence,
  }));
  for (const d of detections) {
    if (!d.detected) continue;
    if (d.signal === "test-weakened" || d.signal === "rejected-architecture") {
      risks.push(d.detail);
    }
    if (d.signal === "tests-not-executed" && opts.builderClaimsTestsPassed) {
      risks.push(d.detail);
    }
  }
  const policyHit = detections.find((d) => d.signal === "qa-rules-changed");
  if (policyHit?.detected) risks.push(policyHit.detail);

  // Remote-push policy: local-only work is not complete when required.
  const remoteDiverged = detections.find((d) => d.signal === "head-vs-remote");
  const remoteBlocked =
    opts.requireRemotePush &&
    (remoteDiverged?.detected ||
      detections.some(
        (d) => d.signal === "no-remote" || d.signal === "remote-unreachable",
      ));
  if (remoteBlocked) {
    unknowns.push(
      "remote push required by policy but local HEAD is not verified on the remote",
    );
  }

  // 9. Verdict from the verifier's initial result + deterministic signals.
  const stopReasons = [...initial.stopReasons];
  if (remoteBlocked) {
    // Not a violation of the work itself; evidence is missing → handled below via unverified check.
    checks.push({
      requirement_id: "REMOTE",
      status: "unverified",
      evidence_grade: "UNAVAILABLE",
      evidence: { reason: "remote push required but unverified" },
    });
  }
  const { verdict, effectiveChecks } = determineVerdict({
    checks,
    notes: initial.notes,
    stopReasons,
  });

  // 10. Builder claims classified only now, against independent evidence.
  const builderClaims: QaReceipt["builder_claims"] = {
    supported: [],
    unsupported: [],
    contradicted: [],
    not_checked: [],
  };
  if (opts.builderReport) {
    const claims = parseBuilderClaims(opts.builderReport);
    for (const c of claims) {
      const cls = classifyBuilderClaim(c);
      const bucket =
        cls === "SUPPORTED"
          ? builderClaims.supported
          : cls === "UNSUPPORTED"
            ? builderClaims.unsupported
            : cls === "CONTRADICTED"
              ? builderClaims.contradicted
              : builderClaims.not_checked;
      bucket?.push(c.claim);
    }
  }

  const integrity = determineIntegrity(initial.integritySignals);

  const receipt: QaReceipt = {
    schema: "mattspi.qa.receipt.v1",
    id: `qa-${randomUUID().slice(0, 8)}`,
    verdict,
    integrity:
      integrity === "OK" && initial.integrity === "SUSPECT"
        ? "SUSPECT"
        : integrity,
    subject: {
      repo: snapshot.repoRoot ?? repoRoot,
      worktree: snapshot.worktree ?? repoRoot,
      branch: snapshot.branch ?? "(detached)",
      base_sha: snapshot.baseSha ?? "unknown",
      head_sha: snapshot.headSha ?? "unknown",
      remote: snapshot.remote,
      remote_sha: snapshot.remoteSha,
      remote_verified:
        snapshot.remoteSha !== null &&
        snapshot.headSha !== null &&
        snapshot.remoteSha === snapshot.headSha,
      dirty: snapshot.dirty,
    },
    intent: {
      spec_id: spec.id,
      spec_revision: spec.revision,
      satisfied: verdict === "PASS" || verdict === "PASS_WITH_NOTES",
    },
    reuse: { searched: reuse.searched, findings: reuse.found.slice(0, 20) },
    verification: effectiveChecks,
    tests: {
      discovered: tests.discovered ? 1 : 0,
      executed: testEvidence.grade === "EXECUTED" ? 1 : 0,
      passed: tests.passed ?? 0,
      failed: tests.failed ?? 0,
    },
    builder_claims: builderClaims,
    lantern: {
      context_pack_id: lanternPack.pack.id,
      decisions_consulted: lanternPack.pack.decisions.map((d) => d.id),
    },
    risks,
    unknowns,
    commands: [
      ...(tests.command && tests.result
        ? [
            {
              command: tests.command,
              exit_code: tests.result.exitCode,
              truncated: tests.result.truncated,
            },
          ]
        : []),
      ...reuse.commands,
    ],
    created_at: new Date().toISOString(),
  };

  const receiptFile = saveReceipt(repoRoot, receipt);
  return {
    receipt,
    receiptFile,
    verifierSpawnArgs: spawnArgs,
    detections,
    promptWithheld,
  };
}

/** Split a builder report into coarse claims (one per non-empty line, capped). */
export function parseBuilderClaims(report: string): BuilderClaim[] {
  return report
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter((l) => l.length > 0)
    .slice(0, 20)
    .map((claim) => ({
      claim,
      evidenceGrade: null,
      contradictsEvidence: false,
    }));
}
