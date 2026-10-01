/**
 * Test evidence: discover the repo's test command from its manifest and
 * run it through the bounded runner. QA records exactly what ran and its
 * exit code. A claim of "tests passed" without an EXECUTED record here
 * (or a verifier-owned run) is REPORTED, never success.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand, type CommandResult } from "./commands.js";

export interface TestEvidence {
  discovered: boolean;
  command: string | null;
  result: CommandResult | null;
  passed: number | null;
  failed: number | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** Discover how this repo runs tests. Node / Python / Rust / Go, in that order. Null = no recognised harness. */
export function discoverTestCommand(repoRoot: string): string[] | null {
  const pkg = readJson(path.join(repoRoot, "package.json"));
  const scripts =
    (pkg?.["scripts"] as Record<string, string> | undefined) ?? undefined;
  if (scripts?.["test"] && scripts["test"].trim() !== "") {
    return ["npm", "test", "--silent"];
  }
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml")))
    return ["cargo", "test"];
  if (fs.existsSync(path.join(repoRoot, "go.mod")))
    return ["go", "test", "./..."];
  if (
    fs.existsSync(path.join(repoRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(repoRoot, "pytest.ini")) ||
    fs.existsSync(path.join(repoRoot, "tests"))
  ) {
    if (
      fs.existsSync(path.join(repoRoot, "pyproject.toml")) ||
      fs.existsSync(path.join(repoRoot, "pytest.ini"))
    )
      return ["pytest", "-q"];
  }
  if (scripts && Object.keys(scripts).length > 0) return null;
  return null;
}

/** Parse common harness summaries from output. Best-effort; nulls mean "could not parse, see exit code". */
export function parseTestSummary(
  command: string[],
  stdout: string,
): { passed: number | null; failed: number | null } {
  const text = stdout;
  // vitest / jest / mocha-ish: "Tests  12 passed, 1 failed" / "12 passing, 1 failing"
  let m =
    /(\d+)\s+passing.*?(\d+)\s+failing/s.exec(text) ??
    /Tests\s+(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i.exec(text);
  if (m)
    return {
      passed: Number(m[1]),
      failed: m[2] !== undefined ? Number(m[2]) : 0,
    };
  m = /(\d+)\s+passed,\s*(\d+)\s+failed/i.exec(text);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  // cargo: "test result: ok. 12 passed; 0 failed"
  m = /test result:\s*ok\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i.exec(text);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  m = /test result:\s*FAILED\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i.exec(text);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  // pytest: "12 passed, 1 failed"
  m = /=\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i.exec(text);
  if (m)
    return {
      passed: Number(m[1]),
      failed: m[2] !== undefined ? Number(m[2]) : 0,
    };
  // node --test TAP: "# pass 12\n# fail 0"; spec reporter: "ℹ pass 12 ... ℹ fail 0"
  m = /# pass\s+(\d+)[\s\S]*?# fail\s+(\d+)/.exec(text);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  m = /ℹ pass\s+(\d+)[\s\S]*?ℹ fail\s+(\d+)/.exec(text);
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  return { passed: null, failed: null };
}

export async function runTests(
  repoRoot: string,
  timeoutMs = 300_000,
): Promise<TestEvidence> {
  const cmd = discoverTestCommand(repoRoot);
  if (!cmd)
    return {
      discovered: false,
      command: null,
      result: null,
      passed: null,
      failed: null,
    };
  const [exe, ...args] = cmd as [string, ...string[]];
  const result = await runCommand(exe, args, { cwd: repoRoot, timeoutMs });
  const summary = parseTestSummary(cmd, result.stdout + "\n" + result.stderr);
  return {
    discovered: true,
    command: result.command,
    result,
    passed: summary.passed,
    failed: summary.failed,
  };
}
