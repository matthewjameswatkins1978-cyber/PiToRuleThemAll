/**
 * Verdict determination and builder-claim classification.
 *
 * Rules (see docs/QA-CONTRACT.md):
 * - Any violated requirement        -> FAIL
 * - Any consequential boundary hit  -> STOP_RECOMMENDED (takes precedence over FAIL)
 * - Any unverified required evidence -> INCONCLUSIVE (unless a violation already failed it)
 * - All satisfied + notes           -> PASS_WITH_NOTES, else PASS
 * - REPORTED-only evidence may not justify PASS on an important requirement;
 *   such checks are downgraded to unverified, which yields INCONCLUSIVE.
 */

import type {
  ClaimClass,
  EvidenceGrade,
  Integrity,
  RequirementCheck,
  Verdict,
} from "./types.js";

export interface VerdictInput {
  checks: RequirementCheck[];
  /** Requirement ids considered important (default: all). */
  important?: string[];
  notes?: string[];
  stopReasons?: string[];
  integritySignals?: string[];
}

const WEAK_GRADES: EvidenceGrade[] = ["REPORTED", "INFERRED", "UNAVAILABLE"];

export function isStrongEnough(
  grade: EvidenceGrade,
  important: boolean,
): boolean {
  if (!important) return grade !== "UNAVAILABLE";
  return grade === "EXECUTED" || grade === "OBSERVED";
}

export function determineVerdict(input: VerdictInput): {
  verdict: Verdict;
  effectiveChecks: RequirementCheck[];
  downgraded: string[];
} {
  const important = new Set(
    input.important ?? input.checks.map((c) => c.requirement_id),
  );
  const downgraded: string[] = [];
  const effectiveChecks = input.checks.map((c) => {
    if (
      c.status === "satisfied" &&
      !isStrongEnough(c.evidence_grade, important.has(c.requirement_id))
    ) {
      downgraded.push(c.requirement_id);
      return { ...c, status: "unverified" as const };
    }
    return c;
  });

  if ((input.stopReasons ?? []).length > 0) {
    return { verdict: "STOP_RECOMMENDED", effectiveChecks, downgraded };
  }
  if (effectiveChecks.length === 0) {
    // Nothing was judged: no evidence, no verdict. Never a silent PASS.
    return { verdict: "INCONCLUSIVE", effectiveChecks, downgraded };
  }
  if (effectiveChecks.some((c) => c.status === "violated")) {
    return { verdict: "FAIL", effectiveChecks, downgraded };
  }
  if (
    effectiveChecks.some(
      (c) => c.status === "unverified" || c.status === "not_checked",
    )
  ) {
    return { verdict: "INCONCLUSIVE", effectiveChecks, downgraded };
  }
  if ((input.notes ?? []).length > 0) {
    return { verdict: "PASS_WITH_NOTES", effectiveChecks, downgraded };
  }
  return { verdict: "PASS", effectiveChecks, downgraded };
}

export function determineIntegrity(signals: string[]): Integrity {
  const s = signals.map((x) => x.toLowerCase());
  if (
    s.some(
      (x) =>
        x.includes("compromised") ||
        x.includes("tamper") ||
        x.includes("defeat"),
    )
  )
    return "COMPROMISED";
  if (
    s.some(
      (x) =>
        x.includes("suspect") ||
        x.includes("altered") ||
        x.includes("mismatch"),
    )
  )
    return "SUSPECT";
  return "OK";
}

export interface BuilderClaim {
  claim: string;
  /** Independent evidence backing the claim, if any. */
  evidenceGrade: EvidenceGrade | null;
  contradictsEvidence: boolean;
}

/** Classify each builder claim only after the verifier formed its own result. */
export function classifyBuilderClaim(c: BuilderClaim): ClaimClass {
  if (c.contradictsEvidence) return "CONTRADICTED";
  if (c.evidenceGrade === null) return "NOT_CHECKED";
  if (c.evidenceGrade === "EXECUTED" || c.evidenceGrade === "OBSERVED")
    return "SUPPORTED";
  return "UNSUPPORTED";
}

const INTEGRITY_RANK: Record<Integrity, number> = {
  OK: 0,
  SUSPECT: 1,
  COMPROMISED: 2,
};

/**
 * Final integrity is the STRONGEST signal from every source.
 * Never downgrades: COMPROMISED from any source survives.
 */
export function maxIntegrity(
  ...values: (Integrity | undefined | null)[]
): Integrity {
  let best: Integrity = "OK";
  for (const v of values) {
    if (v && INTEGRITY_RANK[v] > INTEGRITY_RANK[best]) best = v;
  }
  return best;
}

/**
 * Tamper evaluation (consequential signals). Policy edits alone are a
 * review flag, not a stop. But QA-harness modification COMBINED with
 * evidence-evasion patterns (weakened tests, unexecuted-but-claimed
 * tests) is a defeat attempt: STOP_RECOMMENDED with evidence.
 * Verdict and integrity stay separate axes throughout.
 */
export function evaluateTamper(input: {
  policyChanged: string[];
  harnessChanged: string[];
  testWeakened: boolean;
  testsClaimedButNotExecuted: boolean;
}): { integrity: Integrity; stopReasons: string[]; risks: string[] } {
  const risks: string[] = [];
  const stopReasons: string[] = [];
  let integrity: Integrity = "OK";
  if (input.policyChanged.length > 0) {
    risks.push(
      `QA policy changed on reviewed branch (judged by trusted baseline, requires explicit review): ${input.policyChanged.join(", ")}`,
    );
  }
  if (input.harnessChanged.length > 0) {
    integrity = "SUSPECT";
    risks.push(
      `QA harness modified on reviewed branch (verification tooling itself changed): ${input.harnessChanged.join(", ")}`,
    );
  }
  const evasion =
    input.testWeakened || input.testsClaimedButNotExecuted;
  if (input.harnessChanged.length > 0 && evasion) {
    integrity = "COMPROMISED";
    stopReasons.push(
      `QA defeat pattern: harness modified AND evidence evasion (${[
        input.testWeakened ? "tests weakened" : "",
        input.testsClaimedButNotExecuted
          ? "tests claimed but not executed"
          : "",
      ]
        .filter(Boolean)
        .join(" + ")}); continuing would grade compromised verification`,
    );
  }
  return { integrity, stopReasons, risks };
}

/** Files whose modification on the reviewed branch means QA tooling itself changed. */
export const HARNESS_PATHS = [
  "src/qa/",
  "src/evidence/",
  "src/reuse/",
  "schemas/",
  "agents/verifier.md",
  "extensions/pi-qa/",
];

export { WEAK_GRADES };
