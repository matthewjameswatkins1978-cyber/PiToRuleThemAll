/**
 * /qa preflight (M1). Deterministic, no AI required:
 * inspect Git state → freeze intent into spec revision 1 → identify
 * trusted rules → retrieve Lantern pack when available → bounded reuse
 * discovery → consequential seams → depth → compact report.
 * Preflight never produces PASS/FAIL.
 */

import { LanternClient } from "../adapters/lantern.js";
import { ReuseryClient } from "../adapters/reusery.js";
import {
  boundedDiff,
  changedPolicyFiles,
  readAtRef,
  snapshotGit,
  type GitSnapshot,
} from "../evidence/git.js";
import { resolveReuse, type ReuseReport } from "../reuse/resolver.js";
import { selectDepth } from "./review-depth.js";
import { createSpec, saveSpec } from "./spec.js";
import type { AcceptanceItem } from "./types.js";

export interface PreflightInput {
  rawRequest: string;
  normalizedIntent: string;
  acceptance: AcceptanceItem[];
  constraints?: string[];
  consequentialSeams?: string[];
  focusFile?: string;
  siblingRepos?: string[];
  touchesPublicBehaviour?: boolean;
  trivial?: boolean;
}

export interface PreflightReport {
  specId: string;
  specFile: string;
  snapshot: GitSnapshot;
  trustedRef: string;
  trustedRules: Record<string, string | null>;
  changedPolicyFiles: string[];
  lantern: {
    grade: string;
    packId: string | null;
    decisions: number;
    rejected: number;
    note: string;
  };
  reuse: ReuseReport;
  reusery: { consulted: boolean; outcome: string; note: string };
  depth: string;
  depthReason: string;
  diffFiles: number;
  unknowns: string[];
  text: string;
}

export async function preflight(
  repoRoot: string,
  input: PreflightInput,
  deps: { lantern: LanternClient; reusery: ReuseryClient },
): Promise<PreflightReport> {
  const unknowns: string[] = [];
  const snapshot = await snapshotGit(repoRoot);
  if (!snapshot.isRepo) {
    unknowns.push(
      "not a git repository: branch/base/remote evidence unavailable",
    );
  }

  const trustedRef = snapshot.baseSha ?? snapshot.headSha ?? "worktree";
  const trustedRules: Record<string, string | null> = {};
  for (const f of ["AGENTS.md", "package.json"]) {
    trustedRules[f] =
      snapshot.isRepo && snapshot.baseSha
        ? await readAtRef(repoRoot, snapshot.baseSha, f)
        : null;
  }
  if (Object.values(trustedRules).every((v) => v === null)) {
    unknowns.push("trusted baseline unreadable: policy comparison unavailable");
  }
  const policyChanged =
    snapshot.isRepo && snapshot.baseSha && snapshot.headSha
      ? await changedPolicyFiles(repoRoot, snapshot.baseSha, snapshot.headSha)
      : [];

  const lanternCtx = await deps.lantern.context(input.normalizedIntent);
  if (lanternCtx.grade === "UNAVAILABLE")
    unknowns.push(`lantern: ${lanternCtx.note}`);

  const reuse = await resolveReuse(repoRoot, input.normalizedIntent, {
    focusFile: input.focusFile,
    siblingRepos: input.siblingRepos,
    lanternGrade: lanternCtx.grade,
    reuseryGrade: "UNAVAILABLE",
  });

  const rq = await deps.reusery.query(input.normalizedIntent);
  reuse.searched["reusery"] = rq.grade;
  if (rq.grade !== "UNAVAILABLE") {
    reuse.found.push(
      `reusery: ${rq.outcome} ${rq.candidates.slice(0, 3).join(", ")}`.trim(),
    );
  } else {
    reuse.not_checked.push(`reusery: ${rq.note}`);
  }

  const depth = selectDepth({
    consequentialSeams: input.consequentialSeams,
    touchesPublicBehaviour: input.touchesPublicBehaviour,
    trivial: input.trivial,
  });

  const spec = createSpec({
    rawRequest: input.rawRequest,
    normalizedIntent: input.normalizedIntent,
    acceptance: input.acceptance,
    constraints: input.constraints,
    consequentialSeams: input.consequentialSeams,
    repoRoot,
    branch: snapshot.branch ?? "(detached-or-norepo)",
    baseSha: snapshot.baseSha ?? "unknown",
    reviewDepth: depth.depth,
  });
  const specFile = saveSpec(repoRoot, spec);

  const diff =
    snapshot.isRepo && snapshot.baseSha && snapshot.headSha
      ? await boundedDiff(repoRoot, snapshot.baseSha, snapshot.headSha, 4000)
      : { diff: "", truncated: false, files: [] as string[] };

  const lines = [
    "QA Preflight",
    `Spec: ${spec.id} (revision 1 → ${specFile})`,
    "",
    `Intent: ${input.normalizedIntent}`,
    `Depth: ${depth.depth} — ${depth.reason}`,
    `Repo: ${snapshot.repoRoot ?? repoRoot} branch=${snapshot.branch ?? "?"} head=${snapshot.headSha?.slice(0, 12) ?? "?"} dirty=${snapshot.dirty}`,
    `Trusted ref: ${trustedRef.slice(0, 12)}`,
    policyChanged.length > 0
      ? `!! Policy files changed on this branch: ${policyChanged.join(", ")}`
      : "Policy files: unchanged",
    "",
    "Existing machinery (reuse):",
    ...reuse.found.slice(0, 10).map((f) => `- ${f}`),
    ...(reuse.found.length === 0
      ? ["- (no reuse hits in searched scopes)"]
      : []),
    ...(reuse.not_checked.length > 0 ? ["Not checked:"] : []),
    ...reuse.not_checked.map((n) => `- ${n}`),
    "",
    `Lantern: ${lanternCtx.grade}${lanternCtx.pack.id ? ` pack=${lanternCtx.pack.id}` : ""} decisions=${lanternCtx.pack.decisions.length} rejected=${lanternCtx.pack.rejectedPaths.length}`,
    ...lanternCtx.pack.negativeConstraints
      .slice(0, 5)
      .map((c) => `- constraint: ${c}`),
    "",
    `Consequential seams: ${(input.consequentialSeams ?? []).join(", ") || "none declared"}`,
    `Changed files vs base: ${diff.files.length}`,
    ...(unknowns.length > 0
      ? ["", "Unknowns:", ...unknowns.map((u) => `- ${u}`)]
      : []),
  ];

  return {
    specId: spec.id,
    specFile,
    snapshot,
    trustedRef,
    trustedRules,
    changedPolicyFiles: policyChanged,
    lantern: {
      grade: lanternCtx.grade,
      packId: lanternCtx.pack.id,
      decisions: lanternCtx.pack.decisions.length,
      rejected: lanternCtx.pack.rejectedPaths.length,
      note: lanternCtx.note,
    },
    reuse,
    reusery: {
      consulted: rq.grade !== "UNAVAILABLE",
      outcome: rq.outcome,
      note: rq.note,
    },
    depth: depth.depth,
    depthReason: depth.reason,
    diffFiles: diff.files.length,
    unknowns,
    text: lines.join("\n"),
  };
}
