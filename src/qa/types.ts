/**
 * Shared QA vocabulary. Verdict, evidence grade and integrity are
 * deliberately separate axes: a FAIL can have OK integrity, and an
 * INCONCLUSIVE can be SUSPECT.
 */

export type Verdict =
  "PASS" | "PASS_WITH_NOTES" | "FAIL" | "INCONCLUSIVE" | "STOP_RECOMMENDED";

export type EvidenceGrade =
  "EXECUTED" | "OBSERVED" | "REPORTED" | "INFERRED" | "UNAVAILABLE";

export type Integrity = "OK" | "SUSPECT" | "COMPROMISED";

export type ReviewDepth = "LIGHT" | "STANDARD" | "DEEP";

export type ClaimClass =
  "SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED" | "NOT_CHECKED";

export interface AcceptanceItem {
  id: string;
  requirement: string;
  probe?: string;
}

export interface QaSpec {
  schema: "mattspi.qa.spec.v1";
  id: string;
  created_at: string;
  task: { raw_request: string; normalized_intent: string };
  acceptance: AcceptanceItem[];
  constraints?: string[];
  consequential_seams?: string[];
  project: { repo_root: string; branch: string; base_sha: string };
  review_depth?: ReviewDepth;
  revision: number;
  supersedes?: string;
}

export interface RequirementCheck {
  requirement_id: string;
  status: "satisfied" | "violated" | "unverified" | "not_checked";
  evidence_grade: EvidenceGrade;
  evidence?: Record<string, unknown>;
}

export interface QaReceipt {
  schema: "mattspi.qa.receipt.v1";
  id: string;
  verdict: Verdict;
  integrity: Integrity;
  subject: {
    repo: string;
    worktree?: string;
    branch: string;
    base_sha: string;
    head_sha: string;
    remote?: string | null;
    remote_sha?: string | null;
    remote_verified: boolean;
    dirty?: boolean;
  };
  intent: { spec_id: string; spec_revision: number; satisfied: boolean };
  reuse?: {
    searched?: Record<string, EvidenceGrade>;
    findings?: string[];
  };
  verification: RequirementCheck[];
  tests: {
    discovered: number;
    executed: number;
    passed: number;
    failed: number;
  };
  builder_claims?: {
    supported?: string[];
    unsupported?: string[];
    contradicted?: string[];
    not_checked?: string[];
  };
  lantern?: { context_pack_id?: string | null; decisions_consulted?: string[] };
  risks?: string[];
  unknowns?: string[];
  commands?: { command: string; exit_code: number; truncated?: boolean }[];
  created_at: string;
}
