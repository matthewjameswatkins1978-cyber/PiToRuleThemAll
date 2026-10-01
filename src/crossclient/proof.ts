/**
 * Cross-client proof records (M6). One invocation = one proof marker.
 *
 * Pi prepares the bridge and the evidence; Lucy performs the independent
 * retrieval. `chatgpt.observed` stays false/pending until HER evidence
 * matches — Pi never infers consumption from configuration.
 *
 * Matching rule (§26): marker + memory ID + kind + originator + holder
 * must ALL match. Same text with a different ID proves copying, not
 * shared storage, and is rejected explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LanternClient } from "../adapters/lantern.js";
import type { EvidenceGrade } from "../qa/types.js";

export type CrossClientStatus = "PENDING" | "VERIFIED";

export interface CrossClientReceipt {
  schema: "mattspi.crossclient.v1";
  marker: string;
  memory_id: string;
  kind: string;
  content: string;
  created_at: string;
  project: { repo: string; sha: string };
  pi: { observed: true; evidence_grade: EvidenceGrade };
  lantern: { status: string; persisted: boolean; post_restart: boolean };
  chatgpt: { observed: boolean; status: "PENDING" | "VERIFIED" };
  expected: {
    memory_id: string;
    kind: string;
    originator_actor_id: string;
    holder_actor_id: string;
  };
  provenance: string[];
}

export interface ProofResult {
  marker: string;
  memoryId: string;
  kind: string;
  content: string;
  provenance: string[];
  grades: {
    remember: EvidenceGrade;
    search: EvidenceGrade;
    why: EvidenceGrade;
    postRestart: EvidenceGrade;
  };
}

export function proofMarker(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `pi-crossclient-${stamp}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateCrossClientReceipt(
  doc: unknown,
): { ok: true; receipt: CrossClientReceipt } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc))
    return { ok: false, errors: ["crossclient: must be an object"] };
  if (doc["schema"] !== "mattspi.crossclient.v1")
    errors.push("schema must be 'mattspi.crossclient.v1'");
  for (const f of ["marker", "memory_id", "kind", "content", "created_at"]) {
    if (typeof doc[f] !== "string" || (doc[f] as string).length === 0)
      errors.push(`${f}: must be a non-empty string`);
  }
  const chatgpt = doc["chatgpt"];
  if (!isRecord(chatgpt)) {
    errors.push("chatgpt: must be an object");
  } else {
    if (typeof chatgpt["observed"] !== "boolean")
      errors.push("chatgpt.observed: must be boolean");
    if (chatgpt["status"] !== "PENDING" && chatgpt["status"] !== "VERIFIED")
      errors.push("chatgpt.status: must be PENDING or VERIFIED");
    if (chatgpt["observed"] === true && chatgpt["status"] !== "VERIFIED") {
      errors.push(
        "chatgpt.observed=true requires status VERIFIED (never infer consumption)",
      );
    }
  }
  const expected = doc["expected"];
  if (!isRecord(expected)) {
    errors.push("expected: must be an object");
  } else {
    for (const f of [
      "memory_id",
      "kind",
      "originator_actor_id",
      "holder_actor_id",
    ]) {
      if (typeof expected[f] !== "string")
        errors.push(`expected.${f}: must be a string`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, receipt: doc as unknown as CrossClientReceipt };
}

/**
 * Create one proof marker live: remember → search → why, all EXECUTED,
 * then a fresh-connection search proving persistence. Throws when any
 * required step is not EXECUTED — no partial proofs.
 */
export async function createProof(
  client: LanternClient,
  opts: {
    project: string;
    sha: string;
    reconnect: () => Promise<{
      client: LanternClient;
      close: () => Promise<void>;
    } | null>;
  },
  now: Date = new Date(),
): Promise<ProofResult> {
  const marker = proofMarker(now);
  const content = `Pi To Rule Them All M6 cross-client proof ${marker} (project ${opts.project} @ ${opts.sha}; safe to archive)`;
  const rem = await client.remember("reference", content, {
    originatorActorId: "matthew",
    holderActorId: "matthew",
    salience: 0.5,
  });
  if (!rem.ok || !rem.memoryItemId)
    throw new Error(`remember failed: ${rem.error ?? "missing memory id"}`);
  const memoryId: string = rem.memoryItemId;
  const found = await client.search(marker, {
    includeArchived: false,
    limit: 10,
  });
  if (!found.ok || !found.items.some((m) => m.id === memoryId)) {
    throw new Error(`search did not retrieve marker ${memoryId}`);
  }
  const why = await client.why({ memory_id: memoryId });
  if (!why.ok || why.trail.length === 0)
    throw new Error(
      `why returned no provenance: ${why.error ?? "empty trail"}`,
    );
  const session = await opts.reconnect();
  if (!session) throw new Error("no fresh connection for the persistence leg");
  try {
    const again = await session.client.search(marker, {
      includeArchived: false,
      limit: 10,
    });
    if (!again.ok || !again.items.some((m) => m.id === memoryId)) {
      throw new Error("marker absent after reconnect");
    }
  } finally {
    await session.close().catch(() => {});
  }
  return {
    marker,
    memoryId,
    kind: "reference",
    content,
    provenance: why.trail,
    grades: {
      remember: "EXECUTED",
      search: "EXECUTED",
      why: "EXECUTED",
      postRestart: "EXECUTED",
    },
  };
}

export function buildReceipt(
  proof: ProofResult,
  opts: { repo: string; sha: string; now?: Date },
): CrossClientReceipt {
  const originator =
    proof.provenance
      .find((t) => t.startsWith("originator_actor_id:"))
      ?.split(":")[1] ?? "matthew";
  const holder =
    proof.provenance
      .find((t) => t.startsWith("holder_actor_id:"))
      ?.split(":")[1] ?? "matthew";
  return {
    schema: "mattspi.crossclient.v1",
    marker: proof.marker,
    memory_id: proof.memoryId,
    kind: proof.kind,
    content: proof.content,
    created_at: (opts.now ?? new Date()).toISOString(),
    project: { repo: opts.repo, sha: opts.sha },
    pi: { observed: true, evidence_grade: "EXECUTED" },
    lantern: { status: "READY", persisted: true, post_restart: true },
    chatgpt: { observed: false, status: "PENDING" },
    expected: {
      memory_id: proof.memoryId,
      kind: proof.kind,
      originator_actor_id: originator,
      holder_actor_id: holder,
    },
    provenance: proof.provenance,
  };
}

export function receiptFilePath(
  repoRoot: string,
  marker: string,
  status: "PENDING" | "VERIFIED" = "PENDING",
): string {
  const suffix = status === "VERIFIED" ? "-verified" : "";
  return path.join(
    repoRoot,
    ".pi",
    "qa",
    "crossclient",
    `${marker}${suffix}.json`,
  );
}

export function saveReceipt(
  repoRoot: string,
  receipt: CrossClientReceipt,
): string {
  const checked = validateCrossClientReceipt(receipt);
  if (!checked.ok)
    throw new Error(
      `refusing to save invalid cross-client receipt: ${checked.errors.join("; ")}`,
    );
  const file = receiptFilePath(
    repoRoot,
    receipt.marker,
    receipt.chatgpt.status,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
  return file;
}

export function loadReceipt(
  repoRoot: string,
  marker: string,
  status: "PENDING" | "VERIFIED" = "PENDING",
): CrossClientReceipt {
  const doc = JSON.parse(
    fs.readFileSync(receiptFilePath(repoRoot, marker, status), "utf-8"),
  ) as unknown;
  const checked = validateCrossClientReceipt(doc);
  if (!checked.ok)
    throw new Error(
      `cross-client receipt invalid: ${checked.errors.join("; ")}`,
    );
  return checked.receipt;
}

export function latestReceipt(repoRoot: string): CrossClientReceipt | null {
  const dir = path.join(repoRoot, ".pi", "qa", "crossclient");
  if (!fs.existsSync(dir)) return null;
  let best: CrossClientReceipt | null = null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const doc = JSON.parse(
        fs.readFileSync(path.join(dir, f), "utf-8"),
      ) as unknown;
      const checked = validateCrossClientReceipt(doc);
      if (!checked.ok) continue;
      if (!best || checked.receipt.created_at > best.created_at)
        best = checked.receipt;
    } catch {
      continue;
    }
  }
  return best;
}

/** Tiny copyable handoff for Matthew to paste to Lucy. */
export function renderHandoff(r: CrossClientReceipt): string {
  return [
    "M6 cross-client check",
    "",
    "Search Lantern for:",
    r.marker,
    "",
    "Expected memory ID:",
    r.memory_id,
    "",
    "Then retrieve provenance for:",
    r.memory_id,
    "",
    `Expected: kind=${r.expected.kind}, originator=${r.expected.originator_actor_id}, holder=${r.expected.holder_actor_id}`,
  ].join("\n");
}

export interface ObservedRetrieval {
  marker: string;
  memory_id: string;
  kind: string;
  originator_actor_id: string;
  holder_actor_id: string;
}

/**
 * Match Lucy's returned evidence against the stored receipt. Every
 * identity field must match exactly. Same text with a different ID is
 * copying, not shared storage — rejected with an explicit reason.
 */
export function verifyCrossClientMatch(
  stored: CrossClientReceipt,
  observed: ObservedRetrieval,
): { verified: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  if (observed.marker !== stored.marker)
    mismatches.push(
      `marker: expected ${stored.marker}, got ${observed.marker}`,
    );
  if (observed.memory_id !== stored.expected.memory_id) {
    mismatches.push(
      `memory_id: expected ${stored.expected.memory_id}, got ${observed.memory_id} — same text with a different ID proves copying, not shared storage`,
    );
  }
  if (observed.kind !== stored.expected.kind)
    mismatches.push(
      `kind: expected ${stored.expected.kind}, got ${observed.kind}`,
    );
  if (observed.originator_actor_id !== stored.expected.originator_actor_id) {
    mismatches.push(
      `originator: expected ${stored.expected.originator_actor_id}, got ${observed.originator_actor_id}`,
    );
  }
  if (observed.holder_actor_id !== stored.expected.holder_actor_id) {
    mismatches.push(
      `holder: expected ${stored.expected.holder_actor_id}, got ${observed.holder_actor_id}`,
    );
  }
  return { verified: mismatches.length === 0, mismatches };
}

/**
 * Record Lucy's confirmation as a NEW superseding receipt. History is
 * never rewritten: the PENDING receipt stays on disk.
 */
export function completeReceipt(
  stored: CrossClientReceipt,
  observed: ObservedRetrieval,
  now: Date = new Date(),
): CrossClientReceipt {
  const { verified, mismatches } = verifyCrossClientMatch(stored, observed);
  if (!verified)
    throw new Error(`Lucy evidence does not match: ${mismatches.join("; ")}`);
  return {
    ...stored,
    created_at: now.toISOString(),
    chatgpt: { observed: true, status: "VERIFIED" },
  };
}
