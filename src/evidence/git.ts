/**
 * Git reality snapshot. QA freezes repository reality before judging:
 * branch, HEAD, base, remote SHA, dirty state, ahead/behind, worktrees.
 * All reads go through the bounded runner; nothing here mutates state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "./commands.js";

export interface GitSnapshot {
  isRepo: boolean;
  repoRoot: string | null;
  worktree: string | null;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  baseSha: string | null;
  remote: string | null;
  remoteSha: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  untracked: string[];
  worktrees: string[];
  upstream: string | null;
}

async function git(cwd: string, ...args: string[]) {
  return runCommand("git", args, {
    cwd,
    timeoutMs: 15_000,
    maxChars: 16 * 1024,
  });
}

function parseWorktrees(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    const m = /^worktree (.+)$/.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

export async function snapshotGit(
  cwd: string,
  baseRef?: string,
): Promise<GitSnapshot> {
  const empty: GitSnapshot = {
    isRepo: false,
    repoRoot: null,
    worktree: null,
    branch: null,
    detached: false,
    headSha: null,
    baseSha: null,
    remote: null,
    remoteSha: null,
    ahead: null,
    behind: null,
    dirty: false,
    untracked: [],
    worktrees: [],
    upstream: null,
  };
  const revParse = await git(cwd, "rev-parse", "--show-toplevel");
  if (revParse.exitCode !== 0) return empty;
  const repoRoot = revParse.stdout.trim().split("\n")[0] ?? "";
  if (!repoRoot) return empty;

  const snap: GitSnapshot = { ...empty, isRepo: true, repoRoot, worktree: cwd };
  const branchOut = await git(repoRoot, "branch", "--show-current");
  const branch = branchOut.stdout.trim();
  snap.detached = branch.length === 0;
  snap.branch = snap.detached ? null : branch;

  const head = await git(repoRoot, "rev-parse", "HEAD");
  if (head.exitCode === 0) snap.headSha = head.stdout.trim();

  // Trusted base: the merge-base with the default branch when known, else HEAD.
  if (baseRef) {
    const base = await git(repoRoot, "rev-parse", "--verify", baseRef);
    if (base.exitCode === 0) snap.baseSha = base.stdout.trim();
  }
  if (!snap.baseSha) {
    // Trusted base: origin/main, else local main/master, else HEAD (local-only).
    const candidates = ["origin/main", "main", "master"];
    for (const ref of candidates) {
      const mergeBase = await git(repoRoot, "merge-base", "HEAD", ref);
      if (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) {
        snap.baseSha = mergeBase.stdout.trim();
        break;
      }
    }
    if (!snap.baseSha) snap.baseSha = snap.headSha;
  }

  const status = await git(
    repoRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  );
  const lines = status.stdout.split("\n").filter((l) => l.length > 0);
  snap.dirty = lines.length > 0;
  snap.untracked = lines
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .slice(0, 50);

  const upstream = await git(
    repoRoot,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  );
  if (upstream.exitCode === 0 && upstream.stdout.trim() !== "@{u}") {
    snap.upstream = upstream.stdout.trim();
    const counts = await git(
      repoRoot,
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    );
    if (counts.exitCode === 0) {
      const m = /(\d+)\s+(\d+)/.exec(counts.stdout.trim());
      if (m) {
        snap.ahead = Number(m[1]);
        snap.behind = Number(m[2]);
      }
    }
    const lsRemote = await git(
      repoRoot,
      "ls-remote",
      "origin",
      snap.upstream.replace(/^origin\//, ""),
    );
    if (lsRemote.exitCode === 0) {
      const first = lsRemote.stdout.trim().split("\n")[0]?.split(/\s+/)[0];
      snap.remote = "origin";
      snap.remoteSha = first && /^[0-9a-f]{40}$/.test(first) ? first : null;
    } else {
      snap.remote = "origin";
      snap.remoteSha = null; // unreachable: remote SHA unavailable, not invented
    }
  } else {
    const remotes = await git(repoRoot, "remote");
    const names = remotes.stdout.trim().split("\n").filter(Boolean);
    snap.remote = names[0] ?? null;
    if (snap.remote) {
      const url = await git(repoRoot, "remote", "get-url", snap.remote);
      void url;
    }
  }

  const wt = await git(repoRoot, "worktree", "list", "--porcelain");
  if (wt.exitCode === 0) snap.worktrees = parseWorktrees(wt.stdout);

  return snap;
}

/** Read a file as it exists at the trusted base ref (for policy comparison). Null when unavailable. */
export async function readAtRef(
  repoRoot: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  const r = await git(repoRoot, "show", `${ref}:${relPath}`);
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

/** Policy files whose changes on the reviewed branch must be explicitly reviewed (§11). */
export const POLICY_PATHS = ["AGENTS.md", ".pi/qa/policy.md", "package.json"];

export async function changedPolicyFiles(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const r = await git(
    repoRoot,
    "diff",
    "--name-only",
    `${baseSha}...${headSha}`,
  );
  if (r.exitCode !== 0) return [];
  const changed = new Set(
    r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return POLICY_PATHS.filter((p) => changed.has(p));
}

/** Bounded diff for verifier context. Returns path + truncated indicator; never an unbounded paste. */
export async function boundedDiff(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  maxChars = 40_000,
): Promise<{ diff: string; truncated: boolean; files: string[] }> {
  const filesOut = await git(
    repoRoot,
    "diff",
    "--name-only",
    `${baseSha}...${headSha}`,
  );
  const files =
    filesOut.exitCode === 0
      ? filesOut.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const d = await runCommand(
    "git",
    ["diff", `${baseSha}...${headSha}`, "--", "."],
    {
      cwd: repoRoot,
      timeoutMs: 15_000,
      maxChars,
    },
  );
  return { diff: d.stdout, truncated: d.truncated, files };
}

/** True when the directory is a usable QA subject (exists, is a repo or can be inspected). */
export function describeWorktree(dir: string): {
  exists: boolean;
  isRepo: boolean;
  entries: number;
} {
  if (!fs.existsSync(dir)) return { exists: false, isRepo: false, entries: 0 };
  const entries = fs.readdirSync(dir).length;
  const isRepo = fs.existsSync(path.join(dir, ".git"));
  return { exists: true, isRepo, entries };
}
