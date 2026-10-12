#!/usr/bin/env node
/**
 * Run the deterministic QA test suite: typecheck, build, then node:test
 * over the compiled tests. Pass --live to also enable the opt-in live
 * proofs (Lantern MCP proof and the sg/ast-grep structural-search smoke;
 * without --live those stay honestly skipped).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const live = process.argv.includes("--live");

function run(cmd, args, env) {
  // Pipe (not inherit) so parent QA processes can capture and parse the
  // summary; re-print for human visibility. On Windows, .cmd shims need
  // cmd.exe with separate argv entries (no shell:true: DEP0190, and no
  // pre-joined strings: double-quoting corruption).
  const wrapped =
    process.platform === "win32"
      ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", cmd, ...args] }
      : { cmd, args };
  const r = spawnSync(wrapped.cmd, wrapped.args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
run("npx", ["tsc", "-p", "tsconfig.json"]);
const files = fs
  .readdirSync(path.join(root, "dist", "tests"))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join("dist", "tests", f));
run("node", ["--test", ...files], live ? { PI_QA_LIVE_LANTERN: "1", PI_QA_LIVE_SG: "1" } : {});
