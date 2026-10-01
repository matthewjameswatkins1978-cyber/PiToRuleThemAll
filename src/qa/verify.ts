/**
 * /qa verify (M2 + repairs). Pipeline:
 *
 *   freeze reality → load frozen spec → load trusted rules →
 *   deterministic evidence (tests, format, typecheck) → reuse check →
 *   Lantern pack → Telltail calibration (DEEP/flag) →
 *   fresh independent reviewer → reconcile builder claims (only now) →
 *   tamper evaluation → verdict + max-integrity → receipt → store.
 *
 * The frozen spec cannot silently mutate. The builder narrative reaches
 * nothing until after the verifier's initial verdict.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LanternClient } from "../adapters/lantern.js";
import { ReuseryClient } from "../adapters/reusery.js";
import { shouldRunTelltail, TelltailClient } from "../adapters/telltail.js";
import { TethersClient } from "../adapters/tethers.js";
import { runCommand } from "../evidence/commands.js";
import {
  boundedDiff,
  changedPolicyFiles,
  POLICY_PATHS,
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
import { reconcileBuilderClaims, type ObservedEvidence } from "./claims.js";
import {
  buildVerifierPrompt,
  runIndependentReview,
  type SpawnFn,
  type VerifierBundle,
} from "./independent-review.js";
import { saveReceipt } from "./receipt.js";
import { latestSpec, loadSpec } from "./spec.js";
import {
  determineIntegrity,
  determineVerdict,
  evaluateTamper,
  HARNESS_PATHS,
  maxIntegrity,
} from "./verdict.js";
import type {
  EvidenceGrade,
  QaReceipt,
  RequirementCheck,
  ReviewDepth,
} from "./types.js";

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
  /** Force Telltail calibration (DEEP enables it automatically). */
  telltail?: boolean;
  /** Force Reusery consult even on LIGHT depth. */
  reusery?: boolean;
  /** Deterministic-only review: no model verifier spawn. Cannot PASS. */
  specOnly?: boolean;
}

export interface VerifyOutcome {
  receipt: QaReceipt;
  receiptFile: string;
  verifierSpawnArgs: string[];
  detections: Detection[];
  promptWithheld: boolean;
}

function harnessChangedFiles(files: string[]): string[] {
  return files.filter((f) => {
    const norm = f.replace(/\\/g, "/");
    return HARNESS_PATHS.some((h) => norm === h.replace(/\/$/, "") || norm.startsWith(h));
  });
}

async function scriptExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse((await fs.promises.readFile(path.join(repoRoot, "package.json"), "utf-8")) as string) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.[name] === "string";
  } catch {
    return false;
  }
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
  const spec = opts.specId ? loadSpec(repoRoot, opts.specId) : latestSpec(repoRoot);
  if (!spec) throw new Error("no QA spec found. Run /qa preflight first.");
  const depth: ReviewDepth = spec.review_depth ?? "STANDARD";

  // 1. Freeze reality.
  const snapshot = await snapshotGit(repoRoot);

  // 2. Trusted rules from the base ref, never from the branch under review.
  const baseRef = snapshot.baseSha ?? "HEAD";
  const trustedRules: Record<string, string | null> = {};
  for (const f of ["AGENTS.md", "package.json"]) {
    trustedRules[f] = snapshot.isRepo ? await readAtRef(repoRoot, baseRef, f) : null;
  }

  // 3. Deterministic evidence: tests, format, typecheck.
  const diff =
    snapshot.isRepo && snapshot.baseSha && snapshot.headSha
      ? await boundedDiff(repoRoot, snapshot.baseSha, snapshot.headSha)
      : { diff: "", truncated: false, files: [] as string[] };
  const tests = await runTests(repoRoot);
  const testEvidence = {
    discovered: tests.discovered,
    command: tests.command,
    exit_code: tests.result?.exitCode ?? null,
    total: tests.total,
    passed: tests.passed,
    failed: tests.failed,
    grade: (tests.discovered && tests.result ? "EXECUTED" : "UNAVAILABLE") as EvidenceGrade,
  };
  const commandRecords: { command: string; exit_code: number; truncated?: boolean }[] = [];
  if (tests.command && tests.result) {
    commandRecords.push({ command: tests.command, exit_code: tests.result.exitCode, truncated: tests.result.truncated });
  }
  let formatExitCode: number | null = null;
  let typecheckExitCode: number | null = null;
  if (await scriptExists(repoRoot, "format:check")) {
    const r = await runCommand("npm", ["run", "format:check", "--silent"], { cwd: repoRoot, timeoutMs: 120_000 });
    formatExitCode = r.exitCode;
    commandRecords.push({ command: "npm run format:check", exit_code: r.exitCode, truncated: r.truncated });
  }
  if (await scriptExists(repoRoot, "typecheck")) {
    const r = await runCommand("npm", ["run", "typecheck", "--silent"], { cwd: repoRoot, timeoutMs: 180_000 });
    typecheckExitCode = r.exitCode;
    commandRecords.push({ command: "npm run typecheck", exit_code: r.exitCode, truncated: r.truncated });
  }

  // 4. Reuse check (Reusery gated by depth unless forced).
  const lanternPack = await deps.lantern.context(spec.task.normalized_intent);
  const gateForced = opts.reusery === true || depth !== "LIGHT";
  const reusery = gateForced
    ? await deps.reusery.query(spec.task.normalized_intent)
    : { grade: "UNAVAILABLE" as EvidenceGrade, outcome: "NEEDS_VERIFICATION" as const, candidates: [], note: "NOT_NEEDED: LIGHT depth, local checks only (use --reusery to force)", state: "NOT_NEEDED" as const };
  const reuse = await resolveReuse(repoRoot, spec.task.normalized_intent, {
    focusFile: opts.focusFile,
    siblingRepos: opts.siblingRepos,
    lanternGrade: lanternPack.grade,
    reuseryGrade: reusery.grade,
  });
  if (reusery.grade !== "UNAVAILABLE") {
    reuse.found.push(`reusery: ${reusery.outcome} ${reusery.candidates.slice(0, 3).join(", ")}`.trim());
  } else {
    reuse.not_checked.push(`reusery: ${reusery.note}`);
  }

  // 5. Adversarial detectors (deterministic, pre-verifier).
  const detections: Detection[] = [];
  detections.push(detectWeakenedTests(diff.diff));
  detections.push(detectUnexecutedTestClaim(opts.builderClaimsTestsPassed ?? false, testEvidence.grade === "EXECUTED"));
  detections.push(detectUnnecessaryDependency(opts.addedDependencies ?? [], diff.diff));
  const policyFiles =
    snapshot.isRepo && snapshot.baseSha && snapshot.headSha
      ? await changedPolicyFiles(repoRoot, snapshot.baseSha, snapshot.headSha)
      : [];
  detections.push(detectPolicyChange(policyFiles));
  detections.push(detectRejectedArchitecture(diff.diff, lanternPack.pack.rejectedPaths));
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
  const harnessFiles = harnessChangedFiles(diff.files);

  // 6. Telltail calibration (DEEP or explicit flag): does the checker
  // still catch a known defect today? A failed calibration is SUSPECT.
  const unknowns: string[] = [];
  const risks: string[] = [];
  const integritySignals: string[] = [];
  const telltailGate = shouldRunTelltail(depth, { force: opts.telltail });
  let telltailNote = telltailGate.reason;
  let telltailGrade: EvidenceGrade = "UNAVAILABLE";
  if (telltailGate.run) {
    const { runCalibration } = await import("../adapters/telltail-calibration.js");
    const cal = await runCalibration(repoRoot, deps.telltail);
    telltailGrade = cal.grade;
    telltailNote = cal.note;
    if (cal.grade === "EXECUTED") {
      if (!cal.calibrationPassed) {
        integritySignals.push("behavioural calibration failed: evaluator missed the known defect");
        risks.push(`telltail calibration FAILED: ${cal.note}`);
      }
    } else {
      unknowns.push(`telltail: ${cal.note}`);
    }
  } else {
    unknowns.push(`telltail: ${telltailGate.reason}`);
  }

  if (lanternPack.grade === "UNAVAILABLE") unknowns.push(`lantern: ${lanternPack.note}`);
  if (reusery.grade === "UNAVAILABLE") unknowns.push(`reusery: ${reusery.note}`);
  if (testEvidence.grade === "UNAVAILABLE") unknowns.push("tests: no recognised harness or execution failed");
  if (testEvidence.grade === "EXECUTED" && (testEvidence.passed === null || testEvidence.total === null)) {
    unknowns.push(`tests: exit ${testEvidence.exit_code} but counts unparseable (see command record)`);
  }
  if (diff.truncated) unknowns.push("diff truncated at 40k chars: unshown files marked not_checked by verifier");

  // 7. Independent reviewer — or deterministic-only short-circuit.
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
  let promptWithheld = false;
  try {
    buildVerifierPrompt(bundle, opts.builderReport ?? "SENTINEL");
    promptWithheld = false;
  } catch {
    promptWithheld = true;
  }

  type InitialResult = {
    verdict: string;
    integrity: string;
    checks: { requirement_id: string; status: string; evidence_grade: EvidenceGrade; evidence?: Record<string, unknown> }[];
    notes: string[];
    stopReasons: string[];
    integritySignals: string[];
  };
  let initial: InitialResult;
  let spawnArgs: string[];
  if (opts.specOnly) {
    unknowns.push("spec-only review: semantic verifier skipped; PASS is unreachable on this path");
    initial = { verdict: "INCONCLUSIVE", integrity: "OK", checks: [], notes: [], stopReasons: [], integritySignals: [] };
    spawnArgs = [];
    promptWithheld = true;
  } else {
    const r = await runIndependentReview(repoRoot, bundle, { spawn: opts.spawn });
    initial = r.result;
    spawnArgs = r.spawnArgs;
  }

  // 8. Deterministic signals fold-in.
  const checks: RequirementCheck[] = initial.checks.map((c) => ({
    requirement_id: c.requirement_id,
    status: c.status as RequirementCheck["status"],
    evidence_grade: c.evidence_grade,
    evidence: c.evidence,
  }));
  for (const d of detections) {
    if (!d.detected) continue;
    if (d.signal === "test-weakened" || d.signal === "rejected-architecture") risks.push(d.detail);
    if (d.signal === "tests-not-executed" && opts.builderClaimsTestsPassed) risks.push(d.detail);
  }
  const remoteDiverged = detections.find((d) => d.signal === "head-vs-remote");
  const remoteBlocked =
    opts.requireRemotePush &&
    (remoteDiverged?.detected || detections.some((d) => d.signal === "no-remote" || d.signal === "remote-unreachable"));
  if (remoteBlocked) {
    unknowns.push("remote push required by policy but local HEAD is not verified on the remote");
    checks.push({
      requirement_id: "REMOTE",
      status: "unverified",
      evidence_grade: "UNAVAILABLE",
      evidence: { reason: "remote push required but unverified" },
    });
  }

  // 9. Tamper evaluation: harness changes + evasion = STOP, never downgrade.
  const tamper = evaluateTamper({
    policyChanged: policyFiles,
    harnessChanged: harnessFiles,
    testWeakened: detections.some((d) => d.signal === "test-weakened" && d.detected),
    testsClaimedButNotExecuted: detections.some((d) => d.signal === "tests-not-executed" && d.detected && opts.builderClaimsTestsPassed),
  });
  risks.push(...tamper.risks);
  const stopReasons = [...initial.stopReasons, ...tamper.stopReasons];
  const { verdict, effectiveChecks } = determineVerdict({ checks, notes: initial.notes, stopReasons });

  // 10. Builder claims reconciled only now, against frozen observed evidence.
  const observed: ObservedEvidence = {
    testsExecuted: testEvidence.grade === "EXECUTED",
    testsPassed: testEvidence.passed,
    testsFailed: testEvidence.failed,
    testsExitCode: testEvidence.exit_code,
    formatExitCode,
    typecheckExitCode,
    dirty: snapshot.isRepo ? snapshot.dirty : null,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    remoteSha: snapshot.remoteSha,
    remoteVerified: snapshot.remoteSha !== null && snapshot.headSha !== null && snapshot.remoteSha === snapshot.headSha,
    filesChanged: diff.files,
    extensionLoaded: null,
    commandsExecuted: commandRecords.map((c) => ({ command: c.command, exit_code: c.exit_code })),
  };
  const builderClaims: QaReceipt["builder_claims"] = { supported: [], unsupported: [], contradicted: [], not_checked: [] };
  if (opts.builderReport) {
    for (const rc of reconcileBuilderClaims(opts.builderReport, observed)) {
      const bucket =
        rc.classification === "SUPPORTED"
          ? builderClaims.supported
          : rc.classification === "UNSUPPORTED"
            ? builderClaims.unsupported
            : rc.classification === "CONTRADICTED"
              ? builderClaims.contradicted
              : builderClaims.not_checked;
      bucket?.push(`${rc.claim} — ${rc.reason}`);
    }
  }

  // 11. STOP packaging stays read-only: Tethers is consulted for state,
  // never for permission. QA verdict != permission, always.
  if (verdict === "STOP_RECOMMENDED") {
    const probe = await deps.tethers.probe().catch(() => ({ ok: false as const, version: "", detail: "tethers probe threw" }));
    unknowns.push(
      probe.ok
        ? `tethers boundary present (${probe.detail}); STOP_RECOMMENDED authorises nothing`
        : `tethers: ${probe.detail}; STOP_RECOMMENDED stands on QA evidence alone`,
    );
  }

  const integrity = maxIntegrity(
    determineIntegrity(initial.integritySignals),
    initial.integrity as QaReceipt["integrity"],
    tamper.integrity,
    integritySignals.length > 0 ? "SUSPECT" : "OK",
  );

  const receipt: QaReceipt = {
    schema: "mattspi.qa.receipt.v1",
    id: `qa-${randomUUID().slice(0, 8)}`,
    verdict,
    integrity,
    subject: {
      repo: snapshot.repoRoot ?? repoRoot,
      worktree: snapshot.worktree ?? repoRoot,
      branch: snapshot.branch ?? "(detached)",
      base_sha: snapshot.baseSha ?? "unknown",
      head_sha: snapshot.headSha ?? "unknown",
      remote: snapshot.remote,
      remote_sha: snapshot.remoteSha,
      remote_verified: snapshot.remoteSha !== null && snapshot.headSha !== null && snapshot.remoteSha === snapshot.headSha,
      dirty: snapshot.dirty,
    },
    intent: { spec_id: spec.id, spec_revision: spec.revision, satisfied: verdict === "PASS" || verdict === "PASS_WITH_NOTES" },
    reuse: { searched: reuse.searched, findings: reuse.found.slice(0, 20) },
    verification: effectiveChecks,
    tests: {
      discovered: testEvidence.total ?? 0,
      executed: (testEvidence.passed ?? 0) + (testEvidence.failed ?? 0),
      passed: testEvidence.passed ?? 0,
      failed: testEvidence.failed ?? 0,
    },
    builder_claims: builderClaims,
    lantern: { context_pack_id: lanternPack.pack.id, decisions_consulted: lanternPack.pack.decisions.map((d) => d.id) },
    integrations: {
      lantern: { state: deps.lantern.describe().state, evidence_grade: lanternPack.grade, reason: lanternPack.note },
      telltail: { state: telltailGrade === "EXECUTED" ? "READY" : deps.telltail.describe().state, evidence_grade: telltailGrade, reason: telltailNote },
      reusery: { state: reusery.state, evidence_grade: reusery.grade, reason: reusery.note },
      tethers: { state: deps.tethers.describe().state, evidence_grade: "UNAVAILABLE", reason: deps.tethers.describe().reason },
    },
    risks,
    unknowns,
    commands: [...commandRecords, ...reuse.commands],
    created_at: new Date().toISOString(),
  };

  const receiptFile = saveReceipt(repoRoot, receipt);
  return { receipt, receiptFile, verifierSpawnArgs: spawnArgs, detections, promptWithheld };
}
