/**
 * Reusery adapter (§27/M4). Consumes Reusery's existing stdio MCP surface
 * — never imports its resolver, never reimplements it.
 *
 * Bounded, honest integration:
 * - The proportionality gate decides WHETHER to consult (unchanged).
 * - When consulted: `reusery_catalog` (read-only list) → keyword match
 *   against known primitives → optional `reusery_resolve` with an
 *   EXPLICITLY EMPTY candidate set under the baseline policy, which
 *   yields a real deterministic decision (usually needs_verification
 *   with reasons — and needs_verification != build_locally).
 * - External discovery (discover/enrich) stays OFF unless explicitly
 *   requested: it is open-world and cost-bearing.
 * - `reference` is reported as REFERENCE, never as verified reuse.
 *
 * States (§35): NOT_NEEDED (gate declined) is distinct from UNAVAILABLE
 * (gate accepted but no server), which is distinct from OPERATION_FAILED.
 */

import type { EvidenceGrade } from "../qa/types.js";
import type { IntegrationDescriptor, IntegrationState } from "./integration-state.js";

export type ReuseOutcome = "REUSE" | "ADAPT" | "DEPEND" | "REFERENCE" | "BUILD_LOCALLY" | "NEEDS_VERIFICATION";

export interface ReuseryMcp {
  catalog(): Promise<{
    ok: boolean;
    primitives?: { primitive_id: string; contract_id: string; name: string; description: string }[];
    error?: string;
  }>;
  resolve(
    primitiveId: string,
    contractId: string,
    candidates: { specimen_id: string; reuse_mode: string }[],
  ): Promise<{ ok: boolean; status?: string; outcome?: string; reasons?: string[]; error?: string }>;
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
const LOCAL_ONLY = [/spell|typo/i, /rename/i, /comment/i, /format/i, /small|tiny|trivial/i, /one.?line/i];

export function shouldConsultReusery(intent: string): { consult: boolean; reason: string } {
  if (LOCAL_ONLY.some((re) => re.test(intent))) {
    return { consult: false, reason: "task is small/domain-specific glue; Reusery would be ceremony" };
  }
  const hit = GENERAL_CAPABILITIES.find((re) => re.test(intent));
  if (hit) return { consult: true, reason: `generally solved capability (${hit.source})` };
  return { consult: false, reason: "no generally solved capability detected; local reuse checks suffice" };
}

export class ReuseryClient {
  private state: IntegrationState = "NOT_CONFIGURED";
  private stateReason = "no Reusery MCP bridge";

  constructor(
    private mcp: ReuseryMcp | null,
    private absentReason = "no Reusery MCP bridge (needs PostgreSQL-backed reusery mcp)",
  ) {
    if (mcp) {
      this.state = "UNREACHABLE";
      this.stateReason = "bridge present but catalog not yet read";
    } else {
      this.stateReason = absentReason;
    }
  }

  get configured(): boolean {
    return this.mcp !== null;
  }

  describe(): IntegrationDescriptor {
    return {
      name: "reusery",
      state: this.mcp ? this.state : "NOT_CONFIGURED",
      reason: this.mcp ? this.stateReason : this.absentReason,
      grade: this.state === "READY" ? "EXECUTED" : "UNAVAILABLE",
    };
  }

  /** Read-only catalog probe (no gate, no resolve): proves wiring. */
  async ping(): Promise<{ ok: boolean; primitives: number; note: string }> {
    if (!this.mcp) return { ok: false, primitives: 0, note: this.absentReason };
    try {
      const cat = await this.mcp.catalog();
      if (!cat.ok) return { ok: false, primitives: 0, note: cat.error ?? "catalog failed" };
      this.state = "READY";
      this.stateReason = `catalog read: ${(cat.primitives ?? []).length} primitives`;
      return { ok: true, primitives: (cat.primitives ?? []).length, note: this.stateReason };
    } catch (e) {
      return { ok: false, primitives: 0, note: `threw: ${(e as Error).message}` };
    }
  }

  /**
   * Query Reusery when the gate allows. Returns a real catalog-backed
   * outcome; an explicit `forServer` override lets tests inject fakes.
   */
  async query(
    intent: string,
    opts: { allowExternalDiscovery?: boolean } = {},
  ): Promise<{ grade: EvidenceGrade; outcome: ReuseOutcome; candidates: string[]; note: string; state: IntegrationState }> {
    const gate = shouldConsultReusery(intent);
    if (!gate.consult) {
      return {
        grade: "UNAVAILABLE",
        outcome: "NEEDS_VERIFICATION",
        candidates: [],
        note: `NOT_NEEDED: ${gate.reason}`,
        state: "NOT_NEEDED",
      };
    }
    if (!this.mcp) {
      this.state = "NOT_CONFIGURED";
      this.stateReason = "gate accepted but no Reusery MCP bridge configured";
      return {
        grade: "UNAVAILABLE",
        outcome: "NEEDS_VERIFICATION",
        candidates: [],
        note: `UNAVAILABLE: ${this.stateReason}`,
        state: "NOT_CONFIGURED",
      };
    }
    void opts.allowExternalDiscovery; // external discover/enrich stay off in this bounded integration
    try {
      const cat = await this.mcp.catalog();
      if (!cat.ok) {
        this.state = "OPERATION_FAILED";
        this.stateReason = cat.error ?? "reusery_catalog failed";
        return { grade: "UNAVAILABLE", outcome: "NEEDS_VERIFICATION", candidates: [], note: this.stateReason, state: "OPERATION_FAILED" };
      }
      this.state = "READY";
      const prims = cat.primitives ?? [];
      this.stateReason = `catalog read: ${prims.length} primitives`;
      const lower = intent.toLowerCase();
      const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      const matched = prims.filter((p) => {
        const hay = `${p.name} ${p.description}`.toLowerCase();
        return words.some((w) => hay.includes(w));
      });
      if (matched.length === 0) {
        return {
          grade: "EXECUTED",
          outcome: "NEEDS_VERIFICATION",
          candidates: [],
          note: `catalog consulted (${prims.length} primitives): no keyword match for this intent`,
          state: "READY",
        };
      }
      const first = matched[0];
      if (!first) {
        return { grade: "EXECUTED", outcome: "NEEDS_VERIFICATION", candidates: [], note: "catalog consulted: no match", state: "READY" };
      }
      // Real deterministic decision from Reusery under the baseline
      // policy with an explicitly empty candidate set.
      const res = await this.mcp.resolve(first.primitive_id, first.contract_id, []);
      const outcome = (res.ok ? (res.outcome ?? res.status) : null) as ReuseOutcome | null;
      const reasons = res.ok && res.reasons ? ` reasons: ${res.reasons.slice(0, 3).join("; ")}` : "";
      return {
        grade: "EXECUTED",
        outcome: outcome ?? "NEEDS_VERIFICATION",
        candidates: matched.slice(0, 5).map((m) => `${m.name} (${m.primitive_id})`),
        note: `reusery decision for '${first.name}': ${outcome ?? res.status ?? "unknown"}${reasons}`,
        state: "READY",
      };
    } catch (e) {
      this.state = "UNREACHABLE";
      this.stateReason = `threw: ${(e as Error).message}`;
      return { grade: "UNAVAILABLE", outcome: "NEEDS_VERIFICATION", candidates: [], note: this.stateReason, state: "UNREACHABLE" };
    }
  }
}
