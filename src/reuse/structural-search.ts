/**
 * Structural reuse search via ast-grep (sg). Where rg finds text,
 * ast-grep finds shape: e.g. an existing `function $NAME($$$)` or
 * `retry($$$)` call regardless of formatting. Unavailable tooling is
 * reported as UNAVAILABLE, never papered over.
 */

import { runCommand } from "../evidence/commands.js";
import { resolveAstGrep } from "./tool-discovery.js";

export interface StructuralHit {
  file: string;
  line: number;
  text: string;
}

export interface StructuralSearchResult {
  executed: boolean;
  hits: StructuralHit[];
  executable?: string;
  error?: string;
}

export async function structuralSearch(
  cwd: string,
  pattern: string,
  opts: {
    lang?: string;
    maxHits?: number;
    resolver?: () => Promise<{ exe: string; source: string } | null>;
  } = {},
): Promise<StructuralSearchResult> {
  const maxHits = opts.maxHits ?? 30;
  const resolved = opts.resolver ? await opts.resolver() : await resolveAstGrep();
  if (!resolved) {
    return {
      executed: false,
      hits: [],
      error: "neither sg nor ast-grep on PATH",
    };
  }
  // NOTE: the subcommand is `run`, not `search` (both sg and ast-grep).
  // A previous `search` invocation never worked; the repaired live smoke
  // test now guards against that regression.
  const args = ["run", "--pattern", pattern, "--json", "."];
  if (opts.lang) args.push("--lang", opts.lang);
  const r = await runCommand(resolved.exe, args, {
    cwd,
    timeoutMs: 30_000,
    maxChars: 128 * 1024,
  });
  if (r.exitCode !== 0 && !r.stdout.trim().startsWith("[")) {
    return {
      executed: false,
      hits: [],
      executable: resolved.source,
      error: r.stderr.slice(0, 300) || `${resolved.exe} exit ${r.exitCode}`,
    };
  }
  try {
    const items = JSON.parse(r.stdout) as Array<{
      file?: string;
      range?: { start?: { line?: number } };
      lines?: string;
      text?: string;
    }>;
    const hits = items.slice(0, maxHits).map((it) => ({
      file: String(it.file ?? ""),
      line: Number(it.range?.start?.line ?? 0),
      text: String(it.lines ?? it.text ?? "").slice(0, 300),
    }));
    return { executed: true, hits, executable: resolved.source };
  } catch {
    return {
      executed: false,
      hits: [],
      error: "could not parse ast-grep JSON output",
    };
  }
}

/** Suggest structural patterns for common "already solved?" shapes. */
export function patternsForTask(
  intent: string,
): { pattern: string; lang: string }[] {
  const lower = intent.toLowerCase();
  const out: { pattern: string; lang: string }[] = [];
  if (/retr(y|ies)|backoff|back-off/.test(lower)) {
    out.push({ pattern: "function $F($$$) { $$$ }", lang: "ts" });
    out.push({ pattern: "retry($$$)", lang: "ts" });
  }
  if (/config/.test(lower)) out.push({ pattern: "readFile($$$)", lang: "ts" });
  if (/persist|store|save/.test(lower))
    out.push({ pattern: "writeFile($$$)", lang: "ts" });
  if (/http|fetch|request/.test(lower))
    out.push({ pattern: "fetch($$$)", lang: "ts" });
  return out.slice(0, 4);
}
