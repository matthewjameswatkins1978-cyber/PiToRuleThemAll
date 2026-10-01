/**
 * Telltail adapter (M3). Telltail owns independent behavioural evidence;
 * this project does not copy it. When Telltail is unavailable, core QA
 * continues and marks external behavioural verification UNAVAILABLE.
 */

import type { EvidenceGrade } from "../qa/types.js";

export interface TelltailCaller {
  run(
    scenario: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

export class TelltailClient {
  constructor(private caller: TelltailCaller | null) {}

  get configured(): boolean {
    return this.caller !== null;
  }

  async evaluate(
    scenario: string,
    input: Record<string, unknown>,
  ): Promise<{ grade: EvidenceGrade; verdict?: string; note: string }> {
    if (!this.caller) {
      return {
        grade: "UNAVAILABLE",
        note: "Telltail unavailable: core QA continues without behavioural evidence",
      };
    }
    try {
      const rr = await this.caller.run(scenario, input);
      if (!rr.ok)
        return {
          grade: "UNAVAILABLE",
          note: rr.error ?? "telltail run failed",
        };
      const d = rr.data as { verdict?: unknown };
      return {
        grade: "EXECUTED",
        verdict: typeof d.verdict === "string" ? d.verdict : undefined,
        note: `telltail scenario '${scenario}' executed`,
      };
    } catch (e) {
      return {
        grade: "UNAVAILABLE",
        note: `telltail threw: ${(e as Error).message}`,
      };
    }
  }
}
