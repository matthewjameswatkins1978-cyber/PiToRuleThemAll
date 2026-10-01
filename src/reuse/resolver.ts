/**
 * Reuse resolution policy (§9). The order is the policy:
 *
 *   same file → same module → same repo → approved siblings →
 *   Lantern engineering history → native capability →
 *   installed dependency → Reusery → new implementation
 *
 * The resolver never claims "nothing reusable exists". It reports
 * searched / found / not_checked, because absence of a hit is not proof
 * of universal absence.
 */

import * as path from "node:path";
import type { EvidenceGrade } from "../qa/types.js";
import { patternsForTask, structuralSearch } from "./structural-search.js";
import { cloneSearch } from "./clone-search.js";
import { queriesForTask, textSearch } from "./text-search.js";

export interface ReuseReport {
  searched: Record<string, EvidenceGrade>;
  found: string[];
  not_checked: string[];
  commands: { command: string; exit_code: number }[];
}

export interface ResolverOptions {
  /** File the task centres on (enables same-file/same-module scope). */
  focusFile?: string;
  siblingRepos?: string[];
  /** Skip Lantern/Reusery stages (their adapters decide availability anyway). */
  lanternGrade?: EvidenceGrade;
  reuseryGrade?: EvidenceGrade;
  nativeNotes?: string[];
  dependencyNotes?: string[];
}

export async function resolveReuse(
  repoRoot: string,
  intent: string,
  opts: ResolverOptions = {},
): Promise<ReuseReport> {
  const searched: Record<string, EvidenceGrade> = {};
  const found: string[] = [];
  const notChecked: string[] = [];
  const commands: { command: string; exit_code: number }[] = [];

  const queries = queriesForTask(intent);

  // Stage 1-3: same file → same module → same repo (one rg pass each, narrowing scope).
  const scopes: { name: string; globs: string[] | undefined }[] = [];
  if (opts.focusFile) {
    const rel = path.relative(repoRoot, opts.focusFile) || opts.focusFile;
    scopes.push({ name: "same-file", globs: [rel] });
    scopes.push({ name: "same-module", globs: [`${path.dirname(rel)}/*`] });
  }
  scopes.push({ name: "same-repo", globs: undefined });

  for (const scope of scopes) {
    let scopeHits = 0;
    for (const q of queries.slice(0, 6)) {
      const r = await textSearch(repoRoot, q, {
        globs: scope.globs,
        maxHits: 5,
      });
      commands.push({
        command: `rg ${q} (${scope.name})`,
        exit_code: r.executed ? 0 : 1,
      });
      if (!r.executed) {
        searched["text"] = "UNAVAILABLE";
        break;
      }
      searched["text"] = "EXECUTED";
      scopeHits += r.hits.length;
      for (const h of r.hits.slice(0, 3))
        found.push(
          `${scope.name}: ${h.file}:${h.line} matches '${q}' :: ${h.text.slice(0, 120)}`,
        );
    }
    if ((searched["text"] as string) === "UNAVAILABLE") break;
    void scopeHits;
  }

  // Stage 4: approved siblings (text only, bounded to listed repos).
  if (opts.siblingRepos && opts.siblingRepos.length > 0) {
    let ran = false;
    for (const sib of opts.siblingRepos.slice(0, 3)) {
      for (const q of queries.slice(0, 3)) {
        const r = await textSearch(sib, q, { maxHits: 3 });
        ran = r.executed || ran;
        for (const h of r.hits.slice(0, 2))
          found.push(`sibling(${path.basename(sib)}): ${h.file}:${h.line}`);
      }
    }
    if (!ran)
      notChecked.push(
        "sibling repos: rg unavailable or no siblings configured",
      );
  } else {
    notChecked.push("sibling repos: none configured");
  }

  // Stage 5: Lantern history (adapter-supplied grade; never invented).
  searched["lantern"] = opts.lanternGrade ?? "UNAVAILABLE";
  if (searched["lantern"] === "UNAVAILABLE")
    notChecked.push("lantern history: service unavailable");

  // Stage 6-7: native capability + installed dependency are reviewer notes, not searches.
  for (const n of opts.nativeNotes ?? []) found.push(`native: ${n}`);
  for (const d of opts.dependencyNotes ?? []) found.push(`dependency: ${d}`);

  // Structural search (ast-grep) where patterns apply.
  const patterns = patternsForTask(intent);
  if (patterns.length > 0) {
    let ran = false;
    for (const p of patterns) {
      const r = await structuralSearch(repoRoot, p.pattern, {
        lang: p.lang,
        maxHits: 5,
      });
      commands.push({
        command: `ast-grep ${p.pattern}`,
        exit_code: r.executed ? 0 : 1,
      });
      if (r.executed) {
        ran = true;
        for (const h of r.hits.slice(0, 3))
          found.push(`structural: ${h.file}:${h.line} matches '${p.pattern}'`);
      }
    }
    searched["structural"] = ran ? "EXECUTED" : "UNAVAILABLE";
    if (!ran)
      notChecked.push("structural: ast-grep unavailable or unparsable output");
  } else {
    searched["structural"] = "UNAVAILABLE";
    notChecked.push("structural: no task-shaped patterns applied");
  }

  // Clone search over the repo (bounded).
  try {
    const clones = cloneSearch(
      repoRoot,
      opts.focusFile ? [opts.focusFile] : undefined,
    );
    searched["clones"] = clones.executed ? "EXECUTED" : "UNAVAILABLE";
    for (const c of clones.clones.slice(0, 5)) {
      found.push(
        `clone: ${c.locations.map((l) => `${l.file}:${l.startLine}`).join(" ~ ")}`,
      );
    }
  } catch {
    searched["clones"] = "UNAVAILABLE";
    notChecked.push("clones: scanner error");
  }

  // Stage 8: Reusery (adapter-supplied grade).
  searched["reusery"] = opts.reuseryGrade ?? "UNAVAILABLE";
  if (searched["reusery"] === "UNAVAILABLE")
    notChecked.push("reusery: not consulted (see proportionality gate)");

  return { searched, found, not_checked: notChecked, commands };
}
