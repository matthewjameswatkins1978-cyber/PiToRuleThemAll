/**
 * Reusery adapter (M4). Reusery owns deep reuse discovery; QA consults it
 * only when the task looks like a generally solved engineering capability
 * (proportionality over ceremony). Lack of evidence never becomes
 * BUILD_LOCALLY — it becomes NEEDS_VERIFICATION.
 */

import type { EvidenceGrade } from "../qa/types.js";

export type ReuseOutcome =
  | "REUSE"
  | "ADAPT"
  | "DEPEND"
  | "REFERENCE"
  | "BUILD_LOCALLY"
  | "NEEDS_VERIFICATION";

export interface ReuseryCaller {
  query(task: string): Promise<{
    ok: boolean;
    outcome?: ReuseOutcome;
    candidates?: string[];
    error?: string;
  }>;
}

/** Generally solved capabilities worth a Reusery query. Everything else stays local. */
const GENERAL_CAPABILITIES = [
  /retr(y|ies)|backoff/i,
  /subprocess|child.?process/i,
  /rate.?limit/i,
  /migrat/i,
  /config.*pars|pars.*config/i,
  /mcp.?client/i,
  /http.*retry|retry.*http/i,
  /connection.?pool/i,
  /cache/i,
  /auth.*flow|oauth/i,
];

/** Tiny domain glue that must never trigger a Reusery query. */
const LOCAL_ONLY = [
  /spell|typo/i,
  /rename/i,
  /comment/i,
  /format/i,
  /small|tiny|trivial/i,
  /one.?line/i,
];

export function shouldConsultReusery(intent: string): {
  consult: boolean;
  reason: string;
} {
  if (LOCAL_ONLY.some((re) => re.test(intent))) {
    return {
      consult: false,
      reason: "task is small/domain-specific glue; Reusery would be ceremony",
    };
  }
  const hit = GENERAL_CAPABILITIES.find((re) => re.test(intent));
  if (hit)
    return {
      consult: true,
      reason: `generally solved capability (${hit.source})`,
    };
  return {
    consult: false,
    reason:
      "no generally solved capability detected; local reuse checks suffice",
  };
}

export class ReuseryClient {
  constructor(private caller: ReuseryCaller | null) {}

  get configured(): boolean {
    return this.caller !== null;
  }

  async query(intent: string): Promise<{
    grade: EvidenceGrade;
    outcome: ReuseOutcome;
    candidates: string[];
    note: string;
  }> {
    const gate = shouldConsultReusery(intent);
    if (!gate.consult) {
      return {
        grade: "UNAVAILABLE",
        outcome: "NEEDS_VERIFICATION",
        candidates: [],
        note: `not consulted: ${gate.reason}`,
      };
    }
    if (!this.caller) {
      return {
        grade: "UNAVAILABLE",
        outcome: "NEEDS_VERIFICATION",
        candidates: [],
        note: "Reusery unavailable: local reuse checks continue; external search NOT claimed",
      };
    }
    try {
      const r = await this.caller.query(intent);
      if (!r.ok) {
        return {
          grade: "UNAVAILABLE",
          outcome: "NEEDS_VERIFICATION",
          candidates: [],
          note: r.error ?? "query failed",
        };
      }
      return {
        grade: "EXECUTED",
        outcome: r.outcome ?? "NEEDS_VERIFICATION",
        candidates: r.candidates ?? [],
        note: `reusery outcome: ${r.outcome ?? "NEEDS_VERIFICATION"}`,
      };
    } catch (e) {
      return {
        grade: "UNAVAILABLE",
        outcome: "NEEDS_VERIFICATION",
        candidates: [],
        note: `threw: ${(e as Error).message}`,
      };
    }
  }
}
