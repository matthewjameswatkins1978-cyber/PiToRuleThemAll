/**
 * Lantern Keeper adapter (M0). Lantern owns memory/provenance; this project
 * owns no memory database and performs no raw mutation. Every method
 * degrades to UNAVAILABLE with a reason instead of inventing remembered
 * decisions — inventing memory is the one failure this adapter must
 * never produce.
 *
 * Transport: Lantern's MCP tools (lantern_context, lantern_remember,
 * lantern_search, lantern_why, lantern_correct, lantern_status,
 * lantern_foreman_queue, lantern_foreman_review) via whatever MCP caller
 * the host provides. The core never touches MCP directly; the extension
 * injects a caller, tests inject a fake.
 */

import type { EvidenceGrade } from "../qa/types.js";

export interface LanternCaller {
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

export interface ContextPack {
  id: string | null;
  decisions: { id: string; summary: string }[];
  rejectedPaths: string[];
  negativeConstraints: string[];
  provenance: string[];
}

export const LANTERN_TOOLS = [
  "lantern_context",
  "lantern_remember",
  "lantern_search",
  "lantern_why",
  "lantern_correct",
  "lantern_status",
  "lantern_foreman_queue",
  "lantern_foreman_review",
] as const;

export interface LanternStatus {
  reachable: boolean;
  grade: EvidenceGrade;
  detail: string;
}

export class LanternClient {
  constructor(private caller: LanternCaller | null) {}

  get configured(): boolean {
    return this.caller !== null;
  }

  async status(): Promise<LanternStatus> {
    if (!this.caller) {
      return {
        reachable: false,
        grade: "UNAVAILABLE",
        detail: "no Lantern MCP caller injected (server not connected)",
      };
    }
    try {
      const r = await this.caller.call("lantern_status", {});
      if (!r.ok)
        return {
          reachable: false,
          grade: "UNAVAILABLE",
          detail: r.error ?? "lantern_status failed",
        };
      return {
        reachable: true,
        grade: "EXECUTED",
        detail: "lantern_status ok",
      };
    } catch (e) {
      return {
        reachable: false,
        grade: "UNAVAILABLE",
        detail: `lantern_status threw: ${(e as Error).message}`,
      };
    }
  }

  /** Bounded context pack for a task. Never returns invented content: empty pack + UNAVAILABLE on failure. */
  async context(
    query: string,
    maxItems = 8,
  ): Promise<{ pack: ContextPack; grade: EvidenceGrade; note: string }> {
    const empty: ContextPack = {
      id: null,
      decisions: [],
      rejectedPaths: [],
      negativeConstraints: [],
      provenance: [],
    };
    if (!this.caller)
      return {
        pack: empty,
        grade: "UNAVAILABLE",
        note: "Lantern unavailable: no caller",
      };
    try {
      const r = await this.caller.call("lantern_context", {
        query,
        max_items: maxItems,
      });
      if (!r.ok)
        return {
          pack: empty,
          grade: "UNAVAILABLE",
          note: r.error ?? "lantern_context failed",
        };
      const d = r.data as Partial<ContextPack>;
      return {
        pack: {
          id: typeof d.id === "string" ? d.id : null,
          decisions: Array.isArray(d.decisions)
            ? d.decisions.slice(0, maxItems)
            : [],
          rejectedPaths: Array.isArray(d.rejectedPaths)
            ? d.rejectedPaths.slice(0, maxItems).map(String)
            : [],
          negativeConstraints: Array.isArray(d.negativeConstraints)
            ? d.negativeConstraints.slice(0, maxItems).map(String)
            : [],
          provenance: Array.isArray(d.provenance)
            ? d.provenance.slice(0, maxItems).map(String)
            : [],
        },
        grade: "EXECUTED",
        note: "context pack retrieved",
      };
    } catch (e) {
      return {
        pack: empty,
        grade: "UNAVAILABLE",
        note: `lantern_context threw: ${(e as Error).message}`,
      };
    }
  }

  /** Provenance for a decision/claim id. */
  async why(
    id: string,
  ): Promise<{ trail: string[]; grade: EvidenceGrade; note: string }> {
    if (!this.caller)
      return {
        trail: [],
        grade: "UNAVAILABLE",
        note: "Lantern unavailable: no caller",
      };
    try {
      const r = await this.caller.call("lantern_why", { id });
      if (!r.ok)
        return {
          trail: [],
          grade: "UNAVAILABLE",
          note: r.error ?? "lantern_why failed",
        };
      const d = r.data as { trail?: unknown };
      return {
        trail: Array.isArray(d.trail) ? d.trail.map(String).slice(0, 20) : [],
        grade: "EXECUTED",
        note: "provenance retrieved",
      };
    } catch (e) {
      return {
        trail: [],
        grade: "UNAVAILABLE",
        note: `lantern_why threw: ${(e as Error).message}`,
      };
    }
  }

  /**
   * M0 connectivity proof. Steps: status → remember test object →
   * retrieve it → why/provenance → report. Each step records its grade;
   * the proof is honest about which steps ran.
   */
  async connectivityProof(): Promise<{
    steps: { name: string; grade: EvidenceGrade; detail: string }[];
  }> {
    const steps: { name: string; grade: EvidenceGrade; detail: string }[] = [];
    const st = await this.status();
    steps.push({ name: "lantern_status", grade: st.grade, detail: st.detail });
    if (!st.reachable || !this.caller) {
      steps.push({
        name: "remember",
        grade: "UNAVAILABLE",
        note: "skipped: unreachable",
      } as unknown as {
        name: string;
        grade: EvidenceGrade;
        detail: string;
      });
      return { steps };
    }
    const marker = `pi-qa-m0-${Date.now()}`;
    try {
      const w = await this.caller.call("lantern_remember", {
        kind: "evidence",
        text: `Pi QA M0 connectivity marker ${marker}`,
      });
      steps.push({
        name: "lantern_remember",
        grade: w.ok ? "EXECUTED" : "UNAVAILABLE",
        detail: w.ok ? `stored marker ${marker}` : (w.error ?? "failed"),
      });
      if (!w.ok) return { steps };
      const id = (w.data as { id?: string })?.id ?? marker;
      const s = await this.caller.call("lantern_search", { query: marker });
      steps.push({
        name: "lantern_search",
        grade: s.ok ? "EXECUTED" : "UNAVAILABLE",
        detail: s.ok ? `retrieved marker ${marker}` : (s.error ?? "failed"),
      });
      const y = await this.caller.call("lantern_why", { id });
      steps.push({
        name: "lantern_why",
        grade: y.ok ? "EXECUTED" : "UNAVAILABLE",
        detail: y.ok ? `provenance for ${id}` : (y.error ?? "failed"),
      });
    } catch (e) {
      steps.push({
        name: "proof",
        grade: "UNAVAILABLE",
        detail: `threw: ${(e as Error).message}`,
      });
    }
    return { steps };
  }
}
