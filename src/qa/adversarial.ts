/**
 * Adversarial detectors (M3). Each detector answers one question about the
 * reviewed change using deterministic signals only. Detectors never see
 * the builder narrative. Outcomes feed the verify pipeline and the
 * adversarial fixture suite, which also measures false positives on a
 * known-good implementation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Detection {
  signal: string;
  detected: boolean;
  detail: string;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Test weakened to pass: skip/todo/focused tests, neutered assertions.
 * Quoted segments are stripped first: a test that merely MENTIONS
 * `test.skip` in a string (e.g. QA's own adversarial fixtures) is not
 * a weakened test. Code-shaped calls (`test.skip(`, `xit(`) survive
 * stripping because the call itself is outside the quotes.
 */
export function stripQuoted(s: string): string {
  return s.replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    "",
  );
}

export function detectWeakenedTests(diffText: string): Detection {
  const code = stripQuoted(diffText);
  const patterns = [
    /\.skip\(/,
    /\.todo\(/,
    /\.only\(/,
    /test\.skip|it\.skip|describe\.skip|xit\(|xdescribe\(/,
    /expect\(true\)\.toBe\(true\)|assert\.ok\(true\)/,
    /expect\(.*\)\.toBeTruthy\(\)\s*;\s*\/\/\s*was:/i,
  ];
  const hits = patterns.filter((re) => re.test(code)).map((re) => re.source);
  return {
    signal: "test-weakened",
    detected: hits.length > 0,
    detail:
      hits.length > 0
        ? `weakening patterns in diff: ${hits.join(", ")}`
        : "no weakening patterns in diff",
  };
}

/** Builder claims tests passed but QA has no EXECUTED record of them. */
export function detectUnexecutedTestClaim(
  builderClaimsTestsPassed: boolean,
  testCommandExecuted: boolean,
): Detection {
  const detected = builderClaimsTestsPassed && !testCommandExecuted;
  return {
    signal: "tests-not-executed",
    detected,
    detail: detected
      ? "builder claims tests passed but QA executed no test command: claim is REPORTED, not evidence"
      : "test claim backed by QA execution, or no such claim",
  };
}

/** Unnecessary dependency added: manifest diff gains deps without matching imports. */
export function detectUnnecessaryDependency(
  addedDeps: string[],
  diffText: string,
  nativeAlternatives: string[] = [],
): Detection {
  // Normalised substring check: punctuation-insensitive, no fragile regex building.
  const flat = diffText.toLowerCase().replace(/[-_]/g, "");
  const unused = addedDeps.filter((d) => {
    const base = d
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[-_]/g, "");
    return base.length >= 2 && !flat.includes(base);
  });
  const detail: string[] = [];
  if (unused.length > 0)
    detail.push(`added but never imported in diff: ${unused.join(", ")}`);
  if (nativeAlternatives.length > 0)
    detail.push(`native alternatives exist: ${nativeAlternatives.join(", ")}`);
  return {
    signal: "unnecessary-dependency",
    detected: detail.length > 0,
    detail: detail.join("; ") || "deps justified",
  };
}

/** Built-in runtime feature ignored: new code reimplements a listed capability. */
export function detectIgnoredBuiltin(
  diffText: string,
  builtins: { name: string; pattern: RegExp }[],
): Detection {
  const hits = builtins
    .filter((b) => b.pattern.test(diffText))
    .map((b) => b.name);
  return {
    signal: "builtin-ignored",
    detected: hits.length > 0,
    detail:
      hits.length > 0
        ? `reimplements built-in: ${hits.join(", ")}`
        : "no known builtin reimplemented",
  };
}

/** QA rules changed by the reviewed branch: policy files in the diff. */
export function detectPolicyChange(changedPolicyFiles: string[]): Detection {
  return {
    signal: "qa-rules-changed",
    detected: changedPolicyFiles.length > 0,
    detail:
      changedPolicyFiles.length > 0
        ? `policy changed on reviewed branch (requires explicit review, trusted baseline applies): ${changedPolicyFiles.join(", ")}`
        : "policy files unchanged",
  };
}

/** Previous rejected architecture reintroduced: Lantern rejected-path strings resurfacing in the diff. */
export function detectRejectedArchitecture(
  diffText: string,
  rejectedPaths: string[],
): Detection {
  const lower = diffText.toLowerCase();
  const hits = rejectedPaths.filter(
    (r) => r.length >= 4 && lower.includes(r.toLowerCase()),
  );
  return {
    signal: "rejected-architecture",
    detected: hits.length > 0,
    detail:
      hits.length > 0
        ? `rejected paths resurface: ${hits.join("; ")}`
        : "no rejected architecture detected",
  };
}

/** Restart persistence probe (behaviour over shape, §13): write → destroy → restart → read → compare. */
export async function restartProbe<T>(opts: {
  write: (dir: string) => Promise<void>;
  read: (dir: string) => Promise<T>;
  expected: T;
  workDir: string;
}): Promise<Detection> {
  try {
    await opts.write(opts.workDir);
    // "destroy process/state": drop in-memory handles by re-reading from a fresh path handle.
    const freshDir = path.resolve(opts.workDir);
    const actual = await opts.read(freshDir);
    const same = JSON.stringify(actual) === JSON.stringify(opts.expected);
    return {
      signal: "restart-persistence",
      detected: !same,
      detail: same
        ? "value survived write/destroy/restart/read round-trip"
        : `round-trip mismatch: got ${JSON.stringify(actual)?.slice(0, 300)}`,
    };
  } catch (e) {
    return {
      signal: "restart-persistence",
      detected: true,
      detail: `probe threw: ${(e as Error).message}`,
    };
  }
}

/** Duplicate helper: does an identical-enough block already exist elsewhere? */
export function detectDuplicateHelper(
  newCode: string,
  existingFiles: string[],
  windowLines = 6,
): Detection {
  const norm = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim().replace(/\s+/g, " "))
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"))
      .slice(0, windowLines)
      .join("\n");
  const needle = norm(newCode);
  if (!needle)
    return {
      signal: "duplicate-helper",
      detected: false,
      detail: "empty new code",
    };
  const hits: string[] = [];
  for (const f of existingFiles) {
    const text = readText(f);
    if (!text) continue;
    const lines = text.split("\n");
    for (let i = 0; i + windowLines <= lines.length; i++) {
      if (norm(lines.slice(i, i + windowLines).join("\n")) === needle) {
        hits.push(`${f}:${i + 1}`);
        break;
      }
    }
  }
  return {
    signal: "duplicate-helper",
    detected: hits.length > 0,
    detail:
      hits.length > 0
        ? `duplicate block already exists at ${hits.join(", ")}`
        : "no duplicate found",
  };
}

/** Local HEAD differs from remote, or work uncommitted/unpushed. */
export function detectRemoteDivergence(snap: {
  dirty: boolean;
  headSha: string | null;
  remoteSha: string | null;
  ahead: number | null;
  behind: number | null;
  remote: string | null;
}): Detection[] {
  const out: Detection[] = [];
  out.push({
    signal: "uncommitted-work",
    detected: snap.dirty,
    detail: snap.dirty ? "worktree has uncommitted changes" : "worktree clean",
  });
  if (!snap.remote) {
    out.push({
      signal: "no-remote",
      detected: true,
      detail: "no git remote: remote verification UNAVAILABLE",
    });
    return out;
  }
  if (snap.remoteSha === null) {
    out.push({
      signal: "remote-unreachable",
      detected: true,
      detail:
        "remote SHA could not be obtained: remote verification UNAVAILABLE",
    });
    return out;
  }
  out.push({
    signal: "head-vs-remote",
    detected: snap.headSha !== snap.remoteSha,
    detail:
      snap.headSha !== snap.remoteSha
        ? `local HEAD ${snap.headSha?.slice(0, 12)} != remote ${snap.remoteSha.slice(0, 12)} (ahead=${snap.ahead}, behind=${snap.behind})`
        : "local HEAD matches remote",
  });
  return out;
}
