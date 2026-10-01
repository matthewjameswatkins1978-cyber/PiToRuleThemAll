#!/usr/bin/env node
/**
 * Run the deterministic QA test suite: typecheck, build, then node:test
 * over the compiled tests. Pass --live to also enable the opt-in live
 * Lantern proof (needs Lantern MCP; otherwise it stays honestly skipped).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const live = process.argv.includes("--live");

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
run("npx", ["tsc", "-p", "tsconfig.json"]);
const files = fs
  .readdirSync(path.join(root, "dist", "tests"))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join("dist", "tests", f));
run("node", ["--test", ...files], live ? { PI_QA_LIVE_LANTERN: "1" } : {});
