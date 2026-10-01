/**
 * Independent reviewer (M2, §12). Genuine separate context, not a costume
 * change: the verifier is a fresh `pi` subprocess (`--mode json -p
 * --no-session`) that receives the frozen spec, trusted rules, snapshot,
 * diff and evidence — and NEVER the builder's completion narrative.
 * The builder report is compared only after the verifier forms its own
 * result. The spawn function is injectable so tests prove isolation
 * without a live model.
 */

import { spawn } from "node:child_process";
import { platformSpawn } from "../evidence/commands.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EvidenceGrade } from "./types.js";

export interface VerifierBundle {
  spec: unknown;
  trustedRules: { ref: string; files: Record<string, string | null> };
  snapshot: unknown;
  diff: { files: string[]; text: string; truncated: boolean };
  testEvidence: unknown;
  reuseEvidence: unknown;
  lanternPack: unknown;
  agentPromptPath: string;
}

export interface VerifierResult {
  verdict: string;
  integrity: string;
  checks: {
    requirement_id: string;
    status: string;
    evidence_grade: EvidenceGrade;
    evidence?: Record<string, unknown>;
  }[];
  notes: string[];
  stopReasons: string[];
  integritySignals: string[];
  raw: string;
}

export type SpawnFn = (
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default spawn: fresh pi process, no session, JSON mode. Real isolation. */
export const spawnPiVerifier: SpawnFn = (args, input, opts) =>
  new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-verify-"));
    const bundleFile = path.join(tmp, "bundle.md");
    // argv has OS length limits: the full bundle travels as an appended
    // system-prompt file; argv carries only the short task instruction.
    fs.writeFileSync(bundleFile, input, "utf-8");
    const { exe, argv } = platformSpawn("pi", [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--append-system-prompt",
      bundleFile,
      ...args,
    ]);
    const proc = spawn(exe, argv, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 5000);
    }, opts.timeoutMs);
    proc.stdout.on("data", (d) => {
      out += String(d);
    });
    proc.stderr.on("data", (d) => {
      err += String(d);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      resolve({ exitCode: code ?? 1, stdout: out, stderr: err });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: `spawn failed: ${(e as Error).message}`,
      });
    });
  });

/**
 * Build the verifier prompt. Audit-critical: the builder narrative must
 * not appear here. `assertNoBuilderNarrative` guards the boundary.
 */
export function buildVerifierPrompt(
  bundle: VerifierBundle,
  builderReport: string | null,
): string {
  if (builderReport !== null) {
    throw new Error(
      "builder report must not be passed to buildVerifierPrompt (withhold until initial verdict)",
    );
  }
  return [
    "# Independent QA review",
    "",
    "You are an independent verifier. You have never seen this work before.",
    "Judge ONLY against the frozen spec below. Do not invent requirements.",
    "Return your result as a single JSON object:",
    '{"verdict":"PASS|PASS_WITH_NOTES|FAIL|INCONCLUSIVE|STOP_RECOMMENDED","integrity":"OK|SUSPECT|COMPROMISED",',
    ' "checks":[{"requirement_id":"A1","status":"satisfied|violated|unverified|not_checked","evidence_grade":"EXECUTED|OBSERVED|REPORTED|INFERRED|UNAVAILABLE","evidence":{}}],',
    ' "notes":[],"stopReasons":[],"integritySignals":[]}',
    "",
    "## Frozen QA spec",
    JSON.stringify(bundle.spec, null, 2),
    "",
    `## Trusted rules (ref ${bundle.trustedRules.ref})`,
    JSON.stringify(bundle.trustedRules.files, null, 2),
    "",
    "## Repository snapshot",
    JSON.stringify(bundle.snapshot, null, 2),
    "",
    `## Diff (files: ${(bundle.diff.files ?? []).join(", ") || "none"})`,
    bundle.diff.truncated
      ? "[TRUNCATED — judge only what is shown, mark the rest not_checked]"
      : "",
    bundle.diff.text.slice(0, 40_000),
    "",
    "## Test evidence (QA-executed)",
    JSON.stringify(bundle.testEvidence, null, 2),
    "",
    "## Reuse evidence",
    JSON.stringify(bundle.reuseEvidence, null, 2),
    "",
    "## Lantern context pack",
    JSON.stringify(bundle.lanternPack, null, 2),
    "",
    `## Verifier instructions (${bundle.agentPromptPath})`,
    "Read the verifier agent file at the path above and follow it.",
  ].join("\n");
}

const FINAL_TEXT_RE = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** Extract the last assistant text from pi --mode json event stream. */
export function extractFinalText(jsonStream: string): string {
  let last = "";
  for (const line of jsonStream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: { type?: string; text?: string }[];
        };
      };
      if (
        (ev.type === "message_end" || ev.type === "message") &&
        ev.message?.role === "assistant"
      ) {
        for (const part of ev.message.content ?? []) {
          if (part.type === "text" && part.text) last = part.text;
        }
      }
    } catch {
      // Fallback: scrape text fields from non-JSON lines
      let m: RegExpExecArray | null;
      FINAL_TEXT_RE.lastIndex = 0;
      while ((m = FINAL_TEXT_RE.exec(line)) !== null) {
        try {
          last = JSON.parse(`"${m[1]}"`) as string;
        } catch {
          /* keep previous */
        }
      }
    }
  }
  return last || jsonStream.trim().slice(-8000);
}

export function parseVerifierResult(raw: string): VerifierResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error("verifier returned no JSON object");
  const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const verdict =
    typeof obj["verdict"] === "string" ? obj["verdict"] : "INCONCLUSIVE";
  const integrity =
    typeof obj["integrity"] === "string" ? obj["integrity"] : "SUSPECT";
  const checks = Array.isArray(obj["checks"])
    ? (obj["checks"] as Record<string, unknown>[]).map((c) => ({
        requirement_id: String(c["requirement_id"] ?? "?"),
        status: String(c["status"] ?? "not_checked"),
        evidence_grade: (String(c["evidence_grade"] ?? "UNAVAILABLE") ||
          "UNAVAILABLE") as EvidenceGrade,
        evidence:
          typeof c["evidence"] === "object" && c["evidence"] !== null
            ? (c["evidence"] as Record<string, unknown>)
            : {},
      }))
    : [];
  return {
    verdict,
    integrity,
    checks,
    notes: Array.isArray(obj["notes"])
      ? (obj["notes"] as unknown[]).map(String)
      : [],
    stopReasons: Array.isArray(obj["stopReasons"])
      ? (obj["stopReasons"] as unknown[]).map(String)
      : [],
    integritySignals: Array.isArray(obj["integritySignals"])
      ? (obj["integritySignals"] as unknown[]).map(String)
      : [],
    raw,
  };
}

/**
 * Run the independent review. Proves separation by construction:
 * separate process, --no-session, no builder narrative in the prompt.
 */
export async function runIndependentReview(
  cwd: string,
  bundle: VerifierBundle,
  opts: { spawn?: SpawnFn; timeoutMs?: number } = {},
): Promise<{ result: VerifierResult; spawnArgs: string[] }> {
  const spawnFn = opts.spawn ?? spawnPiVerifier;
  const prompt = buildVerifierPrompt(bundle, null);
  const task =
    "Perform the independent QA review described in the appended bundle. " +
    "Judge only the frozen spec. Return one JSON object and nothing else.";
  const args = [task];
  const out = await spawnFn(args, prompt, {
    cwd,
    timeoutMs: opts.timeoutMs ?? 600_000,
  });
  if (out.exitCode !== 0 && !out.stdout.trim()) {
    return {
      result: {
        verdict: "INCONCLUSIVE",
        integrity: "SUSPECT",
        checks: [],
        notes: [],
        stopReasons: [],
        integritySignals: [
          `verifier process failed: ${out.stderr.slice(0, 300)}`,
        ],
        raw: out.stderr,
      },
      spawnArgs: args,
    };
  }
  const finalText = extractFinalText(out.stdout);
  try {
    return { result: parseVerifierResult(finalText), spawnArgs: args };
  } catch {
    return {
      result: {
        verdict: "INCONCLUSIVE",
        integrity: "SUSPECT",
        checks: [],
        notes: [],
        stopReasons: [],
        integritySignals: ["verifier returned unparsable output"],
        raw: finalText.slice(0, 2000),
      },
      spawnArgs: args,
    };
  }
}
