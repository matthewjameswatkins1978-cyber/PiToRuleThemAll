/**
 * QA Spec lifecycle: create revision 1, supersede with a new revision.
 * The original intent is never silently rewritten: any change produces a
 * new revision that names the revision it supersedes.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AcceptanceItem, QaSpec, ReviewDepth } from "./types.js";
import { validateSpec } from "./validate.js";

export interface SpecInput {
  rawRequest: string;
  normalizedIntent: string;
  acceptance: AcceptanceItem[];
  constraints?: string[];
  consequentialSeams?: string[];
  repoRoot: string;
  branch: string;
  baseSha: string;
  reviewDepth?: ReviewDepth;
}

export function createSpec(input: SpecInput, now: Date = new Date()): QaSpec {
  const short = randomUUID().slice(0, 8);
  const spec: QaSpec = {
    schema: "mattspi.qa.spec.v1",
    id: `qa-spec-${short}`,
    created_at: now.toISOString(),
    task: {
      raw_request: input.rawRequest,
      normalized_intent: input.normalizedIntent,
    },
    acceptance: input.acceptance,
    constraints: input.constraints ?? [],
    consequential_seams: input.consequentialSeams ?? [],
    project: {
      repo_root: input.repoRoot,
      branch: input.branch,
      base_sha: input.baseSha,
    },
    review_depth: input.reviewDepth,
    revision: 1,
  };
  const checked = validateSpec(spec);
  if (!checked.ok)
    throw new Error(
      `BUG: freshly created spec is invalid: ${checked.errors.join("; ")}`,
    );
  return checked.spec;
}

/** Create revision N+1. The caller supplies the changed fields; id stays stable, revision bumps. */
export function reviseSpec(
  prev: QaSpec,
  changes: Partial<
    Pick<
      SpecInput,
      "normalizedIntent" | "acceptance" | "constraints" | "consequentialSeams"
    >
  >,
  now: Date = new Date(),
): QaSpec {
  const next: QaSpec = {
    ...prev,
    created_at: now.toISOString(),
    task: {
      raw_request: prev.task.raw_request,
      normalized_intent:
        changes.normalizedIntent ?? prev.task.normalized_intent,
    },
    acceptance: changes.acceptance ?? prev.acceptance,
    constraints: changes.constraints ?? prev.constraints,
    consequential_seams: changes.consequentialSeams ?? prev.consequential_seams,
    revision: prev.revision + 1,
    supersedes: `${prev.id}#r${prev.revision}`,
  };
  const checked = validateSpec(next);
  if (!checked.ok)
    throw new Error(`revised spec invalid: ${checked.errors.join("; ")}`);
  return checked.spec;
}

export function specFilePath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, ".pi", "qa", "specs", `${specId}.json`);
}

export function saveSpec(repoRoot: string, spec: QaSpec): string {
  const file = specFilePath(repoRoot, spec.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + "\n", "utf-8");
  return file;
}

export function loadSpec(repoRoot: string, specId: string): QaSpec {
  const file = specFilePath(repoRoot, specId);
  if (!fs.existsSync(file))
    throw new Error(`QA spec not found: ${file}. Run /qa preflight first.`);
  const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  const checked = validateSpec(doc);
  if (!checked.ok)
    throw new Error(`QA spec invalid (${file}): ${checked.errors.join("; ")}`);
  return checked.spec;
}

/** Newest spec file by created_at, or null when no preflight has run. */
export function latestSpec(repoRoot: string): QaSpec | null {
  const dir = path.join(repoRoot, ".pi", "qa", "specs");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let best: QaSpec | null = null;
  for (const f of files) {
    try {
      const doc = JSON.parse(
        fs.readFileSync(path.join(dir, f), "utf-8"),
      ) as unknown;
      const checked = validateSpec(doc);
      if (!checked.ok) continue;
      if (best === null || checked.spec.created_at > best.created_at)
        best = checked.spec;
    } catch {
      continue;
    }
  }
  return best;
}
