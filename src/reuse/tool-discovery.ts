/**
 * Deterministic executable discovery (defect H). Many installations
 * expose ast-grep as `sg`; some only as `ast-grep`. Preferred order:
 * sg, then ast-grep — reflecting the actual installed commands.
 * Discovery runs once per QA process and the selection is recorded on
 * every structural result. An injectable resolver keeps unit tests
 * hermetic while the live path proves EXECUTED.
 */

import { runCommand } from "../evidence/commands.js";

let cached: { exe: string; source: string } | null | undefined;

export interface ExecutableResolution {
  exe: string;
  source: string;
}

export async function resolveAstGrep(
  opts: {
    which?: (exe: string) => Promise<string | null>;
  } = {},
): Promise<ExecutableResolution | null> {
  if (cached !== undefined) return cached;
  const which =
    opts.which ??
    (async (exe: string) => {
      const probe = await runCommand(
        process.platform === "win32" ? "where.exe" : "which",
        [exe],
        {
          timeoutMs: 10_000,
          maxChars: 1024,
        },
      );
      if (probe.exitCode !== 0) return null;
      return (
        probe.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)[0] ?? null
      );
    });
  for (const candidate of ["sg", "ast-grep"]) {
    const found = await which(candidate);
    if (found) {
      cached = { exe: candidate, source: `selected '${candidate}' (${found})` };
      return cached;
    }
  }
  cached = null;
  return null;
}

/** Test hook: forget the cached selection. */
export function resetAstGrepCache(): void {
  cached = undefined;
}
