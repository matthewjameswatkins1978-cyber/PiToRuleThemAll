/**
 * Tethers adapter (M5). Tethers owns authority; QA owns the recommendation.
 * This adapter carries STOP_RECOMMENDED out of the QA workflow with its
 * evidence — and nothing else. QA can never authorise through this path:
 * there is deliberately no `authorise()` method.
 */

import type { EvidenceGrade } from "../qa/types.js";

export interface StopRecommendation {
  reason: string;
  evidence: string[];
  specId: string;
  receiptId: string;
}

export interface AuthorityState {
  /** What the authority boundary says, if reachable. */
  decision: "ALLOW" | "ASK" | "DENY" | "UNAVAILABLE";
  note: string;
}

export interface TethersCaller {
  check(
    action: string,
    context: Record<string, unknown>,
  ): Promise<{ ok: boolean; decision?: string; error?: string }>;
}

export class TethersClient {
  constructor(private caller: TethersCaller | null) {}

  get configured(): boolean {
    return this.caller !== null;
  }

  /** Read-only: ask what the boundary currently says. Never authorises. */
  async check(
    action: string,
    context: Record<string, unknown>,
  ): Promise<AuthorityState> {
    if (!this.caller) {
      return {
        decision: "UNAVAILABLE",
        note: "Tethers unreachable: STOP_RECOMMENDED stands on QA evidence alone",
      };
    }
    try {
      const r = await this.caller.check(action, context);
      if (!r.ok)
        return {
          decision: "UNAVAILABLE",
          note: r.error ?? "authority check failed",
        };
      const d = (r.decision ?? "ASK").toUpperCase();
      const decision = d === "ALLOW" || d === "DENY" || d === "ASK" ? d : "ASK";
      return {
        decision,
        note: `authority boundary says ${decision}; QA recommendation unchanged`,
      };
    } catch (e) {
      return {
        decision: "UNAVAILABLE",
        note: `threw: ${(e as Error).message}`,
      };
    }
  }

  /** Package a stop recommendation with its evidence for Matthew/Tethers. */
  packageStop(rec: StopRecommendation): { grade: EvidenceGrade; text: string } {
    const lines = [
      `STOP_RECOMMENDED (${rec.receiptId}, spec ${rec.specId})`,
      `Reason: ${rec.reason}`,
      `Evidence:`,
      ...rec.evidence.map((e) => `  - ${e}`),
      `This recommendation authorises nothing. Tethers remains the authority boundary.`,
    ];
    return { grade: "EXECUTED", text: lines.join("\n") };
  }
}
