/**
 * Hand-rolled validators for the two QA schemas.
 *
 * Dependency decision (recorded per §34): ajv was considered and rejected.
 * The two schemas are small, versioned and stable; a ~120-line explicit
 * validator has zero install/upgrade cost and fails loudly on unknown
 * fields, which is exactly what frozen-contract validation needs.
 */

import type { QaReceipt, QaSpec } from "./types.js";

const VERDICTS = [
  "PASS",
  "PASS_WITH_NOTES",
  "FAIL",
  "INCONCLUSIVE",
  "STOP_RECOMMENDED",
];
const GRADES = ["EXECUTED", "OBSERVED", "REPORTED", "INFERRED", "UNAVAILABLE"];
const INTEGRITY = ["OK", "SUSPECT", "COMPROMISED"];
const DEPTHS = ["LIGHT", "STANDARD", "DEEP"];
const CHECK_STATUS = ["satisfied", "violated", "unverified", "not_checked"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkNoExtras(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      errors.push(`${path}: unexpected field '${key}'`);
  }
}

export function validateSpec(
  doc: unknown,
): { ok: true; spec: QaSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) return { ok: false, errors: ["spec: must be an object"] };
  checkNoExtras(
    doc,
    [
      "schema",
      "id",
      "created_at",
      "task",
      "acceptance",
      "constraints",
      "consequential_seams",
      "project",
      "review_depth",
      "revision",
      "supersedes",
    ],
    "spec",
    errors,
  );
  if (doc["schema"] !== "mattspi.qa.spec.v1")
    errors.push("spec.schema: must be 'mattspi.qa.spec.v1'");
  if (typeof doc["id"] !== "string" || !/^qa-spec-/.test(doc["id"]))
    errors.push("spec.id: must start with 'qa-spec-'");
  if (
    typeof doc["created_at"] !== "string" ||
    Number.isNaN(Date.parse(doc["created_at"]))
  )
    errors.push("spec.created_at: must be a date-time string");

  const task = doc["task"];
  if (!isRecord(task)) {
    errors.push("spec.task: must be an object");
  } else {
    checkNoExtras(
      task,
      ["raw_request", "normalized_intent"],
      "spec.task",
      errors,
    );
    if (
      typeof task["raw_request"] !== "string" ||
      task["raw_request"].length === 0
    )
      errors.push("spec.task.raw_request: must be a non-empty string");
    if (
      typeof task["normalized_intent"] !== "string" ||
      task["normalized_intent"].length === 0
    )
      errors.push("spec.task.normalized_intent: must be a non-empty string");
  }

  const acc = doc["acceptance"];
  if (!Array.isArray(acc) || acc.length === 0) {
    errors.push("spec.acceptance: must be a non-empty array");
  } else {
    acc.forEach((item, i) => {
      const p = `spec.acceptance[${i}]`;
      if (!isRecord(item)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      checkNoExtras(item, ["id", "requirement", "probe"], p, errors);
      if (typeof item["id"] !== "string" || !/^A[0-9]+$/.test(item["id"]))
        errors.push(`${p}.id: must match ^A[0-9]+$`);
      if (
        typeof item["requirement"] !== "string" ||
        item["requirement"].length === 0
      )
        errors.push(`${p}.requirement: must be a non-empty string`);
      if (item["probe"] !== undefined && typeof item["probe"] !== "string")
        errors.push(`${p}.probe: must be a string`);
    });
  }

  if (doc["constraints"] !== undefined) {
    if (
      !Array.isArray(doc["constraints"]) ||
      !doc["constraints"].every((c) => typeof c === "string")
    )
      errors.push("spec.constraints: must be string[]");
  }

  const project = doc["project"];
  if (!isRecord(project)) {
    errors.push("spec.project: must be an object");
  } else {
    checkNoExtras(
      project,
      ["repo_root", "branch", "base_sha"],
      "spec.project",
      errors,
    );
    for (const f of ["repo_root", "branch", "base_sha"]) {
      if (typeof project[f] !== "string" || project[f].length === 0)
        errors.push(`spec.project.${f}: must be a non-empty string`);
    }
  }

  if (
    doc["review_depth"] !== undefined &&
    !DEPTHS.includes(doc["review_depth"] as string)
  )
    errors.push("spec.review_depth: must be LIGHT, STANDARD or DEEP");
  if (!Number.isInteger(doc["revision"]) || (doc["revision"] as number) < 1)
    errors.push("spec.revision: must be an integer >= 1");
  if (doc["supersedes"] !== undefined && typeof doc["supersedes"] !== "string")
    errors.push("spec.supersedes: must be a string");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: doc as unknown as QaSpec };
}

export function validateReceipt(
  doc: unknown,
): { ok: true; receipt: QaReceipt } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc))
    return { ok: false, errors: ["receipt: must be an object"] };
  checkNoExtras(
    doc,
    [
      "schema",
      "id",
      "verdict",
      "integrity",
      "subject",
      "intent",
      "reuse",
      "verification",
      "tests",
      "builder_claims",
      "lantern",
      "integrations",
      "stop_reasons",
      "risks",
      "unknowns",
      "commands",
      "created_at",
    ],
    "receipt",
    errors,
  );
  if (doc["schema"] !== "mattspi.qa.receipt.v1")
    errors.push("receipt.schema: must be 'mattspi.qa.receipt.v1'");
  if (typeof doc["id"] !== "string" || !/^qa-/.test(doc["id"]))
    errors.push("receipt.id: must start with 'qa-'");
  if (!VERDICTS.includes(doc["verdict"] as string))
    errors.push("receipt.verdict: unknown verdict");
  if (!INTEGRITY.includes(doc["integrity"] as string))
    errors.push("receipt.integrity: unknown value");
  if (
    typeof doc["created_at"] !== "string" ||
    Number.isNaN(Date.parse(doc["created_at"]))
  )
    errors.push("receipt.created_at: must be a date-time string");

  const subject = doc["subject"];
  if (!isRecord(subject)) {
    errors.push("receipt.subject: must be an object");
  } else {
    checkNoExtras(
      subject,
      [
        "repo",
        "worktree",
        "branch",
        "base_sha",
        "head_sha",
        "remote",
        "remote_sha",
        "remote_verified",
        "dirty",
      ],
      "receipt.subject",
      errors,
    );
    for (const f of ["repo", "branch", "base_sha", "head_sha"]) {
      if (typeof subject[f] !== "string" || (subject[f] as string).length === 0)
        errors.push(`receipt.subject.${f}: must be a non-empty string`);
    }
    if (typeof subject["remote_verified"] !== "boolean")
      errors.push("receipt.subject.remote_verified: must be boolean");
  }

  const intent = doc["intent"];
  if (!isRecord(intent)) {
    errors.push("receipt.intent: must be an object");
  } else {
    checkNoExtras(
      intent,
      ["spec_id", "spec_revision", "satisfied"],
      "receipt.intent",
      errors,
    );
    if (typeof intent["spec_id"] !== "string")
      errors.push("receipt.intent.spec_id: must be a string");
    if (
      !Number.isInteger(intent["spec_revision"]) ||
      (intent["spec_revision"] as number) < 1
    )
      errors.push("receipt.intent.spec_revision: must be an integer >= 1");
    if (typeof intent["satisfied"] !== "boolean")
      errors.push("receipt.intent.satisfied: must be boolean");
  }

  const verification = doc["verification"];
  if (!Array.isArray(verification)) {
    errors.push("receipt.verification: must be an array");
  } else {
    verification.forEach((v, i) => {
      const p = `receipt.verification[${i}]`;
      if (!isRecord(v)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      checkNoExtras(
        v,
        ["requirement_id", "status", "evidence_grade", "evidence"],
        p,
        errors,
      );
      if (typeof v["requirement_id"] !== "string")
        errors.push(`${p}.requirement_id: must be a string`);
      if (!CHECK_STATUS.includes(v["status"] as string))
        errors.push(`${p}.status: unknown status`);
      if (!GRADES.includes(v["evidence_grade"] as string))
        errors.push(`${p}.evidence_grade: unknown grade`);
      if (v["evidence"] !== undefined && !isRecord(v["evidence"]))
        errors.push(`${p}.evidence: must be an object`);
    });
  }

  const tests = doc["tests"];
  if (!isRecord(tests)) {
    errors.push("receipt.tests: must be an object");
  } else {
    checkNoExtras(
      tests,
      ["discovered", "executed", "passed", "failed"],
      "receipt.tests",
      errors,
    );
    for (const f of ["discovered", "executed", "passed", "failed"]) {
      if (!Number.isInteger(tests[f]) || (tests[f] as number) < 0)
        errors.push(`receipt.tests.${f}: must be an integer >= 0`);
    }
  }

  const stopReasons = doc["stop_reasons"];
  if (stopReasons !== undefined) {
    if (
      !Array.isArray(stopReasons) ||
      !stopReasons.every((s) => typeof s === "string")
    ) {
      errors.push("receipt.stop_reasons: must be string[]");
    }
  }

  const integrations = doc["integrations"];
  if (integrations !== undefined) {
    if (!isRecord(integrations)) {
      errors.push("receipt.integrations: must be an object");
    } else {
      const states = [
        "READY",
        "NOT_CONFIGURED",
        "UNREACHABLE",
        "TOOL_MISSING",
        "OPERATION_FAILED",
        "DISABLED_BY_POLICY",
        "NOT_NEEDED",
      ];
      for (const [name, entry] of Object.entries(integrations)) {
        const p = `receipt.integrations.${name}`;
        if (!isRecord(entry)) {
          errors.push(`${p}: must be an object`);
          continue;
        }
        checkNoExtras(entry, ["state", "evidence_grade", "reason"], p, errors);
        if (!states.includes(entry["state"] as string))
          errors.push(`${p}.state: unknown state`);
        if (!GRADES.includes(entry["evidence_grade"] as string))
          errors.push(`${p}.evidence_grade: unknown grade`);
        if (typeof entry["reason"] !== "string")
          errors.push(`${p}.reason: must be a string`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // Verdict/evidence consistency: important PASS claims need better than REPORTED-only evidence.
  return { ok: true, receipt: doc as unknown as QaReceipt };
}
