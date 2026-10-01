/**
 * Lantern Keeper adapter — aligned with the live MCP contract
 * (lantern-keeper apps/lighting/src/mcp.rs + docs/mcp.md).
 *
 * Raw Lantern shapes are translated HERE into Pi QA's ContextPack.
 * Pi QA never assumes Lantern's API has QA's shape, never touches
 * SurrealDB structures, and never duplicates Lantern's domain model.
 *
 * Transport: any LanternCaller (Pi ctx.executeTool in-session, or the
 * stdio MCP transport spawning the real `lighting mcp` bridge).
 * Unknown arguments are rejected server-side, so this adapter sends
 * exactly the contracted fields — nothing more.
 */

import type { EvidenceGrade } from "../qa/types.js";
import type {
  IntegrationDescriptor,
  IntegrationState,
} from "./integration-state.js";

export interface LanternCaller {
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/** Soft memory kinds accepted by lantern_remember (plus factual "claim"). */
export const LANTERN_MEMORY_KINDS = [
  "claim",
  "quote",
  "idea",
  "fragment",
  "impression",
  "anecdote",
  "creative_seed",
  "pattern_candidate",
  "strength_observation",
  "lesson",
  "open_loop",
  "tension",
  "rejected_path",
  "negative_constraint",
  "reference",
  "humour",
  "other",
] as const;

export type LanternMemoryKind = (typeof LANTERN_MEMORY_KINDS)[number];

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

// ---- Raw Lantern API shapes (subset Pi QA consumes) ----

export interface LanternMemoryItem {
  id: string;
  kind: string;
  content: string;
  episode_id?: string | null;
  source_id?: string | null;
  originator_actor_id?: string | null;
  transmitter_actor_id?: string | null;
  holder_actor_id?: string | null;
  salience?: number;
  archived?: boolean;
  created_at?: string;
}

export interface LanternBelief {
  id: string;
  holder_key: string;
  subject_key: string;
  predicate_key: string;
  current_value: string;
  stale?: boolean;
  confidence?: number;
}

export interface LanternContextBody {
  id: string;
  query?: string;
  current_beliefs?: LanternBelief[];
  historical_beliefs?: LanternBelief[];
  soft_memories?: LanternMemoryItem[];
  source_refs?: string[];
}

export interface LanternProvenance {
  source_id?: string | null;
  episode_id?: string | null;
  originator_actor_id?: string | null;
  transmitter_actor_id?: string | null;
  holder_actor_id?: string | null;
}

// ---- Pi QA shape (ours) ----

export interface ContextPack {
  id: string | null;
  decisions: { id: string; summary: string }[];
  rejectedPaths: string[];
  negativeConstraints: string[];
  provenance: string[];
}

export interface ProofStep {
  name: string;
  grade: EvidenceGrade;
  detail: string;
}

export interface ConnectivityProof {
  steps: ProofStep[];
  marker: string;
  memoryId: string | null;
  passed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asMemoryItems(v: unknown): LanternMemoryItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((r) => ({
    id: String(r["id"] ?? ""),
    kind: String(r["kind"] ?? "other"),
    content: String(r["content"] ?? ""),
    episode_id: typeof r["episode_id"] === "string" ? r["episode_id"] : null,
    source_id: typeof r["source_id"] === "string" ? r["source_id"] : null,
    originator_actor_id:
      typeof r["originator_actor_id"] === "string"
        ? r["originator_actor_id"]
        : null,
    transmitter_actor_id:
      typeof r["transmitter_actor_id"] === "string"
        ? r["transmitter_actor_id"]
        : null,
    holder_actor_id:
      typeof r["holder_actor_id"] === "string" ? r["holder_actor_id"] : null,
    salience: typeof r["salience"] === "number" ? r["salience"] : undefined,
    archived: r["archived"] === true,
    created_at:
      typeof r["created_at"] === "string" ? r["created_at"] : undefined,
  }));
}

function asBeliefs(v: unknown): LanternBelief[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((r) => ({
    id: String(r["id"] ?? ""),
    holder_key: String(r["holder_key"] ?? ""),
    subject_key: String(r["subject_key"] ?? ""),
    predicate_key: String(r["predicate_key"] ?? ""),
    current_value: String(r["current_value"] ?? ""),
    stale: r["stale"] === true,
    confidence:
      typeof r["confidence"] === "number" ? r["confidence"] : undefined,
  }));
}

/**
 * Translate a raw lantern_context body into Pi QA's ContextPack.
 * Beliefs become decisions; rejected_path / negative_constraint soft
 * memories become constraints; ids become provenance pointers.
 */
export function translateContext(body: unknown): ContextPack {
  const empty: ContextPack = {
    id: null,
    decisions: [],
    rejectedPaths: [],
    negativeConstraints: [],
    provenance: [],
  };
  if (!isRecord(body)) return empty;
  // Server returns {context: {...}} via the bridge (structuredContent).
  const ctx = isRecord(body["context"]) ? body["context"] : body;
  if (!isRecord(ctx)) return empty;
  const pack: ContextPack = {
    id: typeof ctx["id"] === "string" ? ctx["id"] : null,
    decisions: [],
    rejectedPaths: [],
    negativeConstraints: [],
    provenance: [],
  };
  const beliefs = [
    ...asBeliefs(ctx["current_beliefs"]),
    ...asBeliefs(ctx["historical_beliefs"]),
  ];
  for (const b of beliefs) {
    if (!b.id) continue;
    pack.decisions.push({
      id: b.id,
      summary: `${b.subject_key}.${b.predicate_key} = ${b.current_value}`,
    });
    pack.provenance.push(`belief:${b.id}`);
  }
  const soft = asMemoryItems(ctx["soft_memories"]);
  for (const m of soft) {
    if (m.kind === "rejected_path") pack.rejectedPaths.push(m.content);
    else if (m.kind === "negative_constraint")
      pack.negativeConstraints.push(m.content);
  }
  if (pack.id) pack.provenance.unshift(`context:${pack.id}`);
  const refs = ctx["source_refs"];
  if (Array.isArray(refs)) {
    for (const r of refs.slice(0, 20)) {
      if (typeof r === "string" && r) pack.provenance.push(`source:${r}`);
    }
  }
  return pack;
}

export function translateProvenance(whyResult: unknown): string[] {
  const trail: string[] = [];
  if (!isRecord(whyResult)) return trail;
  const prov = isRecord(whyResult["provenance"])
    ? whyResult["provenance"]
    : null;
  if (prov && isRecord(prov)) {
    for (const k of [
      "source_id",
      "episode_id",
      "originator_actor_id",
      "transmitter_actor_id",
      "holder_actor_id",
    ]) {
      const v = prov[k];
      if (typeof v === "string" && v) trail.push(`${k}:${v}`);
    }
  }
  const item = isRecord(whyResult["memory_item"])
    ? whyResult["memory_item"]
    : null;
  if (item && isRecord(item) && typeof item["id"] === "string")
    trail.unshift(`memory:${item["id"]}`);
  const claims = whyResult["supporting_claims"];
  if (Array.isArray(claims)) {
    for (const c of claims.slice(0, 10)) {
      if (isRecord(c) && typeof c["id"] === "string")
        trail.push(`claim:${c["id"]}`);
    }
  }
  return trail;
}

export class LanternClient {
  private state: IntegrationState = "NOT_CONFIGURED";
  private stateReason = "no Lantern caller injected";
  private version: string | undefined;

  constructor(
    private caller: LanternCaller | null,
    private absentReason = "no Lantern MCP caller (server not connected)",
  ) {
    if (caller) {
      this.state = "UNREACHABLE";
      this.stateReason = "caller present but status not yet checked";
    } else {
      this.stateReason = absentReason;
    }
  }

  get configured(): boolean {
    return this.caller !== null;
  }

  describe(): IntegrationDescriptor {
    return {
      name: "lantern",
      state: this.caller ? this.state : "NOT_CONFIGURED",
      reason: this.caller ? this.stateReason : this.absentReason,
      grade: this.state === "READY" ? "EXECUTED" : "UNAVAILABLE",
      version: this.version,
    };
  }

  async status(): Promise<{
    reachable: boolean;
    grade: EvidenceGrade;
    detail: string;
    version?: unknown;
  }> {
    if (!this.caller) {
      this.state = "NOT_CONFIGURED";
      this.stateReason = "no Lantern MCP caller (server not connected)";
      return {
        reachable: false,
        grade: "UNAVAILABLE",
        detail: this.stateReason,
      };
    }
    try {
      const r = await this.caller.call("lantern_status", {});
      if (!r.ok) {
        this.state = "UNREACHABLE";
        this.stateReason = r.error ?? "lantern_status failed";
        return {
          reachable: false,
          grade: "UNAVAILABLE",
          detail: this.stateReason,
        };
      }
      this.state = "READY";
      this.stateReason = "lantern_status ok";
      const data = (r.data ?? {}) as { version?: unknown };
      const ver = isRecord(data["version"])
        ? (data["version"]["version"] ?? data["version"]["name"])
        : undefined;
      if (typeof ver === "string") this.version = ver;
      return {
        reachable: true,
        grade: "EXECUTED",
        detail: "lantern_status ok",
        version: data["version"],
      };
    } catch (e) {
      this.state = "UNREACHABLE";
      this.stateReason = `lantern_status threw: ${(e as Error).message}`;
      return {
        reachable: false,
        grade: "UNAVAILABLE",
        detail: this.stateReason,
      };
    }
  }

  async remember(
    kind: string,
    content: string,
    opts: {
      originatorActorId?: string;
      holderActorId?: string;
      transmitterActorId?: string;
      salience?: number;
    } = {},
  ): Promise<{
    ok: boolean;
    memoryItemId: string | null;
    raw?: unknown;
    error?: string;
  }> {
    if (!LANTERN_MEMORY_KINDS.includes(kind as LanternMemoryKind)) {
      return {
        ok: false,
        memoryItemId: null,
        error: `unsupported kind '${kind}'; expected one of ${LANTERN_MEMORY_KINDS.join(", ")}`,
      };
    }
    if (!this.caller)
      return {
        ok: false,
        memoryItemId: null,
        error: "Lantern unavailable: no caller",
      };
    const args: Record<string, unknown> = { kind, content };
    if (opts.originatorActorId)
      args["originator_actor_id"] = opts.originatorActorId;
    if (opts.holderActorId) args["holder_actor_id"] = opts.holderActorId;
    if (opts.transmitterActorId)
      args["transmitter_actor_id"] = opts.transmitterActorId;
    if (opts.salience !== undefined) args["salience"] = opts.salience;
    try {
      const r = await this.caller.call("lantern_remember", args);
      if (!r.ok)
        return {
          ok: false,
          memoryItemId: null,
          error: r.error ?? "lantern_remember failed",
        };
      const data = (r.data ?? {}) as { memory_item?: unknown };
      const item = isRecord(data["memory_item"]) ? data["memory_item"] : null;
      const id = item && typeof item["id"] === "string" ? item["id"] : null;
      return { ok: true, memoryItemId: id, raw: r.data };
    } catch (e) {
      return {
        ok: false,
        memoryItemId: null,
        error: `lantern_remember threw: ${(e as Error).message}`,
      };
    }
  }

  async search(
    phrase: string,
    opts: { includeArchived?: boolean; limit?: number } = {},
  ): Promise<{ ok: boolean; items: LanternMemoryItem[]; error?: string }> {
    if (!this.caller)
      return { ok: false, items: [], error: "Lantern unavailable: no caller" };
    try {
      const r = await this.caller.call("lantern_search", {
        phrase,
        include_archived: opts.includeArchived ?? false,
        limit: opts.limit ?? 10,
      });
      if (!r.ok)
        return {
          ok: false,
          items: [],
          error: r.error ?? "lantern_search failed",
        };
      const data = (r.data ?? {}) as { memory_items?: unknown };
      return { ok: true, items: asMemoryItems(data["memory_items"]) };
    } catch (e) {
      return {
        ok: false,
        items: [],
        error: `lantern_search threw: ${(e as Error).message}`,
      };
    }
  }

  async why(
    target: { memory_id: string } | { belief_id: string } | { query: string },
  ): Promise<{ ok: boolean; trail: string[]; raw?: unknown; error?: string }> {
    if (!this.caller)
      return { ok: false, trail: [], error: "Lantern unavailable: no caller" };
    try {
      const r = await this.caller.call(
        "lantern_why",
        target as Record<string, unknown>,
      );
      if (!r.ok)
        return { ok: false, trail: [], error: r.error ?? "lantern_why failed" };
      return { ok: true, trail: translateProvenance(r.data), raw: r.data };
    } catch (e) {
      return {
        ok: false,
        trail: [],
        error: `lantern_why threw: ${(e as Error).message}`,
      };
    }
  }

  async context(
    query: string,
    opts: {
      itemBudget?: number;
      tokenBudget?: number;
      projectHints?: string[];
      scope?: Record<string, string>;
      intent?: string;
      actor?: string;
    } = {},
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
    const args: Record<string, unknown> = {
      query,
      // Bounded defaults: enough for QA, never a memory dump.
      item_budget: opts.itemBudget ?? 8,
      token_budget: opts.tokenBudget ?? 2000,
    };
    if (opts.actor) args["actor"] = opts.actor;
    if (opts.projectHints) args["project_hints"] = opts.projectHints;
    if (opts.scope) args["scope"] = opts.scope;
    if (opts.intent) args["intent"] = opts.intent;
    try {
      const r = await this.caller.call("lantern_context", args);
      if (!r.ok)
        return {
          pack: empty,
          grade: "UNAVAILABLE",
          note: r.error ?? "lantern_context failed",
        };
      const pack = translateContext(r.data);
      return {
        pack,
        grade: "EXECUTED",
        note: `context pack ${pack.id ?? "(no id)"} retrieved and translated`,
      };
    } catch (e) {
      return {
        pack: empty,
        grade: "UNAVAILABLE",
        note: `lantern_context threw: ${(e as Error).message}`,
      };
    }
  }

  /**
   * M0 connectivity proof. Executes the full lifecycle against the real
   * contract and stores every artifact. Passes only when every required
   * step is EXECUTED. `reconnect` supplies a fresh caller to prove the
   * post-restart leg over a new connection.
   */
  async connectivityProof(opts: {
    marker: string;
    content: string;
    /**
     * Fresh client over a NEW connection (proves post-restart retrieval).
     * Opened lazily at the reconnect leg; closed by the proof afterwards.
     */
    reconnect: () => Promise<{
      client: LanternClient;
      close: () => Promise<void>;
    } | null>;
  }): Promise<ConnectivityProof> {
    const steps: ProofStep[] = [];
    const fail = (name: string, detail: string): ConnectivityProof => {
      steps.push({ name, grade: "UNAVAILABLE", detail });
      return { steps, marker: opts.marker, memoryId: null, passed: false };
    };

    const st = await this.status();
    steps.push({ name: "lantern_status", grade: st.grade, detail: st.detail });
    if (!st.reachable || !this.caller)
      return { steps, marker: opts.marker, memoryId: null, passed: false };

    const rem = await this.remember("reference", opts.content, {
      originatorActorId: "matthew",
      holderActorId: "matthew",
      salience: 0.5,
    });
    steps.push({
      name: "lantern_remember",
      grade: rem.ok && rem.memoryItemId ? "EXECUTED" : "UNAVAILABLE",
      detail: rem.ok
        ? `stored marker, memory_id=${rem.memoryItemId ?? "(missing id)"}`
        : (rem.error ?? "failed"),
    });
    if (!rem.ok || !rem.memoryItemId)
      return { steps, marker: opts.marker, memoryId: null, passed: false };
    const memoryId = rem.memoryItemId;

    const found = await this.search(opts.marker, {
      includeArchived: false,
      limit: 10,
    });
    const retrieved = found.ok && found.items.some((m) => m.id === memoryId);
    steps.push({
      name: "lantern_search",
      grade: retrieved ? "EXECUTED" : "UNAVAILABLE",
      detail: retrieved
        ? `marker retrieved by phrase search (memory_id=${memoryId})`
        : (found.error ?? `marker id ${memoryId} absent from search results`),
    });
    if (!retrieved)
      return { steps, marker: opts.marker, memoryId, passed: false };

    const why = await this.why({ memory_id: memoryId });
    steps.push({
      name: "lantern_why",
      grade: why.ok && why.trail.length > 0 ? "EXECUTED" : "UNAVAILABLE",
      detail: why.ok
        ? `provenance: ${why.trail.join(", ") || "(empty trail)"}`
        : (why.error ?? "failed"),
    });
    if (!why.ok || why.trail.length === 0)
      return { steps, marker: opts.marker, memoryId, passed: false };

    // Fresh connection leg: restart persistence over a new connection.
    const session = await opts.reconnect();
    if (!session) {
      steps.push({
        name: "reconnect",
        grade: "UNAVAILABLE",
        detail: "no fresh client supplied: post-restart leg unverified",
      });
      return { steps, marker: opts.marker, memoryId, passed: false };
    }
    const fresh = session.client;
    const freshStatus = await fresh.status();
    steps.push({
      name: "reconnect_status",
      grade: freshStatus.grade,
      detail: freshStatus.reachable
        ? "fresh connection healthy"
        : freshStatus.detail,
    });
    if (!freshStatus.reachable)
      return { steps, marker: opts.marker, memoryId, passed: false };

    const again = await fresh.search(opts.marker, {
      includeArchived: false,
      limit: 10,
    });
    const persisted = again.ok && again.items.some((m) => m.id === memoryId);
    steps.push({
      name: "post_restart_search",
      grade: persisted ? "EXECUTED" : "UNAVAILABLE",
      detail: persisted
        ? `marker survives reconnect (memory_id=${memoryId})`
        : (again.error ?? "marker absent after reconnect"),
    });
    try {
      await session.close();
    } catch {
      /* close is best-effort */
    }
    if (!persisted)
      return { steps, marker: opts.marker, memoryId, passed: false };

    return { steps, marker: opts.marker, memoryId, passed: true };
  }
}
