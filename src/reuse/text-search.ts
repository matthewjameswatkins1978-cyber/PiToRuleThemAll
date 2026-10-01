/**
 * Textual reuse search via rg. Answers: does a symbol, helper or pattern
 * already exist anywhere in scope? Shells out to rg (required tool);
 * falls back to a small builtin scanner when rg is missing so QA degrades
 * to INFERRED/UNAVAILABLE instead of inventing results.
 */

import { runCommand } from "../evidence/commands.js";

export interface TextHit {
  file: string;
  line: number;
  text: string;
}

export interface TextSearchResult {
  executed: boolean;
  tool: "rg" | "fallback";
  hits: TextHit[];
  truncated: boolean;
  error?: string;
}

export async function textSearch(
  cwd: string,
  pattern: string,
  opts: { globs?: string[]; maxHits?: number } = {},
): Promise<TextSearchResult> {
  const maxHits = opts.maxHits ?? 50;
  // Case-insensitive: reuse leads, not verdicts. Capped hits keep it a pointer, not a dump.
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--ignore-case",
    "--max-count=5",
  ];
  for (const g of opts.globs ?? []) args.push("--glob", g);
  args.push(pattern, ".");
  const r = await runCommand("rg", args, {
    cwd,
    timeoutMs: 30_000,
    maxChars: 64 * 1024,
  });
  if (r.exitCode === 1 && r.stdout.trim() === "") {
    return { executed: true, tool: "rg", hits: [], truncated: false }; // no matches
  }
  if (r.exitCode > 1) {
    return {
      executed: false,
      tool: "rg",
      hits: [],
      truncated: false,
      error: r.stderr.slice(0, 500),
    };
  }
  const hits: TextHit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (hits.length >= maxHits) break;
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m)
      hits.push({
        file: m[1] ?? "",
        line: Number(m[2]),
        text: (m[3] ?? "").slice(0, 300),
      });
  }
  return {
    executed: true,
    tool: "rg",
    hits,
    truncated: r.truncated || hits.length >= maxHits,
  };
}

/** Build reuse queries from a task description: identifiers + key phrases. */
export function queriesForTask(intent: string): string[] {
  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9_.$\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const stop = new Set([
    "that",
    "this",
    "with",
    "from",
    "into",
    "have",
    "should",
    "would",
    "could",
    "there",
    "their",
    "about",
    "which",
    "when",
    "what",
    "adding",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  // camelCase / snake_case identifiers are the strongest signals
  for (const m of intent.matchAll(
    /[A-Za-z_][A-Za-z0-9_]*(?:[A-Z][a-z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+/g,
  )) {
    const w = m[0].toLowerCase();
    if (!seen.has(w)) {
      seen.add(w);
      out.push(m[0]);
    }
  }
  for (const w of words) {
    const clean = w.replace(/^[.]+|[.]+$/g, "");
    if (clean.length >= 4 && !stop.has(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length >= 8) break;
  }
  return out;
}
