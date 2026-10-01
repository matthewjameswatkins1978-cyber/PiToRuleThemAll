/**
 * Bounded duplicate-block detection.
 *
 * jscpd decision (§10, recorded): evaluated, NOT added. jscpd brings a
 * second analysis platform with unbounded-scan defaults; what QA needs is
 * a bounded "does this exact/near block already exist twice?" answer over
 * the files a change touches. The normaliser below (strip comments +
 * blank lines + collapse whitespace, sliding window of N lines) answers
 * that deterministically with zero dependencies. Revisit only if false
 * negatives on renamed-identifier clones cause a real missed-reuse.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface CloneHit {
  hash: string;
  lines: number;
  locations: { file: string; startLine: number }[];
}

export interface CloneSearchResult {
  executed: boolean;
  filesScanned: number;
  clones: CloneHit[];
  skipped: string[];
}

const DEFAULT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const WINDOW = 12;

function normaliseLine(line: string): string | null {
  let s = line.trim();
  if (!s) return null;
  if (s.startsWith("//") || s.startsWith("#") || s.startsWith("*")) return null;
  s = s
    .replace(/\/\/.*$/, "")
    .replace(/#.*$/, "")
    .trim();
  if (!s) return null;
  return s.replace(/\s+/g, " ");
}

function walk(
  dir: string,
  out: string[],
  exts: Set<string>,
  skipped: string[],
  depth: number,
): void {
  if (out.length >= MAX_FILES || depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    skipped.push(dir);
    return;
  }
  for (const e of entries) {
    if (
      e.name === "node_modules" ||
      e.name === ".git" ||
      e.name === "dist" ||
      e.name.startsWith(".")
    )
      continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, exts, skipped, depth + 1);
    else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase()))
      out.push(full);
  }
}

export function cloneSearch(root: string, files?: string[]): CloneSearchResult {
  const skipped: string[] = [];
  let candidates: string[];
  if (files && files.length > 0) {
    candidates = files.map((f) =>
      path.isAbsolute(f) ? f : path.join(root, f),
    );
  } else {
    candidates = [];
    walk(root, candidates, DEFAULT_EXTS, skipped, 0);
  }
  const seen = new Map<
    string,
    { file: string; startLine: number; lines: number }[]
  >();
  let scanned = 0;
  for (const file of candidates.slice(0, MAX_FILES)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      skipped.push(file);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      skipped.push(file);
      continue;
    }
    scanned++;
    const norm: { line: number; text: string }[] = [];
    text.split("\n").forEach((raw, i) => {
      const n = normaliseLine(raw);
      if (n) norm.push({ line: i + 1, text: n });
    });
    for (let i = 0; i + WINDOW <= norm.length; i++) {
      const window = norm.slice(i, i + WINDOW);
      const hash = createHash("sha1")
        .update(window.map((w) => w.text).join("\n"))
        .digest("hex")
        .slice(0, 16);
      const list = seen.get(hash) ?? [];
      list.push({ file, startLine: window[0]?.line ?? 0, lines: WINDOW });
      seen.set(hash, list);
    }
  }
  const clones: CloneHit[] = [];
  for (const [hash, locs] of seen) {
    const distinctFiles = new Set(locs.map((l) => l.file));
    if (distinctFiles.size >= 2 || locs.length >= 2) {
      // Keep one entry per file for readability
      const byFile = new Map<string, { file: string; startLine: number }>();
      for (const l of locs)
        if (!byFile.has(l.file))
          byFile.set(l.file, { file: l.file, startLine: l.startLine });
      if (byFile.size >= 2 || locs.length >= 2) {
        clones.push({
          hash,
          lines: WINDOW,
          locations: [...byFile.values()].slice(0, 5),
        });
      }
    }
    if (clones.length >= 20) break;
  }
  return {
    executed: true,
    filesScanned: scanned,
    clones,
    skipped: skipped.slice(0, 20),
  };
}
