/** Test helpers: temp git repos and fixture loading. No network, no model. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../src/evidence/commands.js";

export async function git(cwd: string, ...args: string[]) {
  const r = await runCommand(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args],
    { cwd },
  );
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.slice(0, 500)}`);
  return r;
}

/** Fresh temp repo with one commit. Returns dir. */
export async function makeTempRepo(
  files: Record<string, string> = { "README.md": "hi\n" },
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-test-"));
  await git(dir, "init", "-b", "main");
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "init");
  return dir;
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-test-"));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function readFixtureJson(rel: string): unknown {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, rel), "utf-8"),
  ) as unknown;
}
