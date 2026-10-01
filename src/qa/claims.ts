/**
 * Builder-claim reconciliation (defect I). The old code marked every
 * claim NOT_CHECKED because parseBuilderClaims attached no evidence.
 *
 * This engine deterministically matches common completion claims
 * against QA-observed evidence. No fuzzy optimism: a claim is
 * SUPPORTED only when observed numbers match, CONTRADICTED when they
 * conflict, UNSUPPORTED when claimed without QA evidence, and
 * NOT_CHECKED when the semantics cannot be grounded deterministically.
 * Reviewer independence is preserved: reconciliation runs only AFTER
 * the verifier's initial verdict, against the same frozen evidence.
 */

import type { ClaimClass } from "./types.js";

export interface ObservedEvidence {
  testsExecuted: boolean;
  testsPassed: number | null;
  testsFailed: number | null;
  testsExitCode: number | null;
  formatExitCode: number | null;
  typecheckExitCode: number | null;
  dirty: boolean | null;
  branch: string | null;
  headSha: string | null;
  remoteSha: string | null;
  remoteVerified: boolean;
  filesChanged: string[];
  extensionLoaded: boolean | null;
  commandsExecuted: { command: string; exit_code: number }[];
}

export interface ReconciledClaim {
  claim: string;
  classification: ClaimClass;
  reason: string;
}

function shaMatch(text: string, sha: string | null): boolean {
  if (!sha) return false;
  const m = /([0-9a-f]{7,40})/i.exec(text);
  if (!m?.[1]) return false;
  const short = m[1].toLowerCase();
  return (
    sha.toLowerCase().startsWith(short) ||
    short.startsWith(sha.toLowerCase().slice(0, 7))
  );
}

export function reconcileBuilderClaims(
  report: string,
  ev: ObservedEvidence,
): ReconciledClaim[] {
  const lines = report
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter((l) => l.length > 0)
    .slice(0, 20);
  return lines.map((claim) => reconcileOne(claim, ev));
}

function reconcileOne(claim: string, ev: ObservedEvidence): ReconciledClaim {
  const lower = claim.toLowerCase();
  const unsupported = (reason: string): ReconciledClaim => ({
    claim,
    classification: "UNSUPPORTED",
    reason,
  });
  const notChecked = (reason: string): ReconciledClaim => ({
    claim,
    classification: "NOT_CHECKED",
    reason,
  });

  // "127 tests passed" / "tests pass" / "all green"
  let m = /(\d+)\s+tests?\s+pass/i.exec(claim);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (!ev.testsExecuted)
      return unsupported(
        "builder claims N tests passed but QA executed no test command",
      );
    if (ev.testsPassed === null)
      return unsupported(
        `builder says ${n} passed but QA could not parse counts (exit ${ev.testsExitCode})`,
      );
    if (ev.testsPassed === n && (ev.testsFailed ?? 0) === 0)
      return {
        claim,
        classification: "SUPPORTED",
        reason: `observed ${ev.testsPassed} pass / ${ev.testsFailed} fail`,
      };
    return {
      claim,
      classification: "CONTRADICTED",
      reason: `builder says ${n} passed; QA observed ${ev.testsPassed ?? "?"} pass / ${ev.testsFailed ?? "?"} fail`,
    };
  }
  if (/tests?\s+(pass|green|ok\b)|all (tests? )?green/i.test(claim)) {
    if (!ev.testsExecuted)
      return unsupported("claimed tests pass but QA executed no test command");
    if ((ev.testsFailed ?? 0) === 0 && (ev.testsExitCode ?? 1) === 0) {
      const counts =
        ev.testsPassed === null
          ? "counts unparseable, exit code only"
          : `${ev.testsPassed} passed`;
      return {
        claim,
        classification: "SUPPORTED",
        reason: `test command exit ${ev.testsExitCode} (${counts})`,
      };
    }
    return {
      claim,
      classification: "CONTRADICTED",
      reason: `QA test run failed (exit ${ev.testsExitCode}, ${ev.testsFailed} failures)`,
    };
  }

  // "format passed / clean"
  if (/format.*(pass|clean|ok)|prettier.*(pass|clean|ok)/i.test(claim)) {
    if (ev.formatExitCode === null)
      return unsupported("format claimed but QA ran no format check");
    return ev.formatExitCode === 0
      ? { claim, classification: "SUPPORTED", reason: "format:check exit 0" }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: `format:check exit ${ev.formatExitCode}`,
        };
  }
  // "typecheck passed"
  if (/typecheck.*(pass|clean|ok)|tsc.*(pass|ok)|types?.*ok/i.test(claim)) {
    if (ev.typecheckExitCode === null)
      return unsupported("typecheck claimed but QA ran no typecheck");
    return ev.typecheckExitCode === 0
      ? { claim, classification: "SUPPORTED", reason: "typecheck exit 0" }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: `typecheck exit ${ev.typecheckExitCode}`,
        };
  }

  // "tree clean" / "no uncommitted changes"
  if (
    /tree clean|working tree clean|no uncommitted|nothing to commit/i.test(
      claim,
    )
  ) {
    if (ev.dirty === null)
      return unsupported("clean tree claimed but QA has no worktree snapshot");
    return ev.dirty === false
      ? { claim, classification: "SUPPORTED", reason: "worktree clean" }
      : { claim, classification: "CONTRADICTED", reason: "worktree is dirty" };
  }

  // branch / SHA / push / sync claims
  if (/\bbranch\b/i.test(claim) && ev.branch) {
    return claim.includes(ev.branch)
      ? { claim, classification: "SUPPORTED", reason: `branch is ${ev.branch}` }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: `actual branch is ${ev.branch}`,
        };
  }
  if (/\b(head|sha|commit|revision)\b/i.test(claim)) {
    if (shaMatch(claim, ev.headSha))
      return { claim, classification: "SUPPORTED", reason: "SHA matches HEAD" };
    if (ev.headSha)
      return {
        claim,
        classification: "CONTRADICTED",
        reason: `HEAD is ${ev.headSha.slice(0, 12)}`,
      };
    return unsupported("SHA claimed but QA has no HEAD");
  }
  if (/\bpushed\b|in sync|remote.*(match|verified|up to date)/i.test(claim)) {
    if (ev.remoteVerified)
      return {
        claim,
        classification: "SUPPORTED",
        reason: "HEAD equals remote SHA",
      };
    if (ev.remoteSha === null)
      return unsupported("push/sync claimed but remote SHA unavailable");
    return {
      claim,
      classification: "CONTRADICTED",
      reason: "local HEAD differs from remote",
    };
  }

  // "N files changed" / file lists
  m = /(\d+)\s+files?\s+(changed|added|touched)/i.exec(claim);
  if (m?.[1]) {
    const n = Number(m[1]);
    return ev.filesChanged.length === n
      ? { claim, classification: "SUPPORTED", reason: `${n} files in diff` }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: `diff has ${ev.filesChanged.length} files, not ${n}`,
        };
  }

  // "extension loaded" / "command executed"
  if (/extension loaded|package loads/i.test(claim)) {
    if (ev.extensionLoaded === null)
      return unsupported("extension load claimed but QA did not check it");
    return ev.extensionLoaded
      ? {
          claim,
          classification: "SUPPORTED",
          reason: "extension load observed",
        }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: "extension failed to load",
        };
  }
  m = /(?:ran|executed|run) `?([^`]+)`?/i.exec(claim);
  if (m?.[1]) {
    const cmd = m[1].trim();
    const seen = ev.commandsExecuted.find(
      (c) =>
        c.command.includes(cmd) || cmd.includes(c.command.split(" ")[0] ?? ""),
    );
    if (!seen) return unsupported(`no QA record of executing '${cmd}'`);
    return seen.exit_code === 0
      ? {
          claim,
          classification: "SUPPORTED",
          reason: `'${seen.command}' exit 0`,
        }
      : {
          claim,
          classification: "CONTRADICTED",
          reason: `'${seen.command}' exit ${seen.exit_code}`,
        };
  }

  // Semantic claims that cannot be grounded stay NOT_CHECKED.
  if (
    /proven|robust|production.?ready|cross.?platform|secure|performant|complete(ly)?|correct/i.test(
      claim,
    )
  ) {
    return notChecked(
      "semantic claim cannot be grounded in deterministic evidence",
    );
  }
  return notChecked("no deterministic rule matches this claim");
}
