/**
 * Telltail adapter (§25/§26). Telltail is a CLI/test-lab, not an MCP
 * server — integration is process-based, deterministic, and never a live
 * per-review LLM call. It evaluates observable worker behaviour, which is
 * exactly QA-of-QA: did the worker actually do the thing, or only claim it?
 *
 * Discovery: `telltail` on PATH, else `go run <module>/cmd/telltail`
 * (module path resolved from TELLTAIL_REPO env or the well-known local
 * clone). No installation is performed silently; `go install` remains a
 * documented manual step.
 *
 * Gating policy (§26): LIGHT never runs Telltail; STANDARD only when
 * behavioural evidence materially helps (explicit flag); DEEP enables it;
 * explicit force always runs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runCommand } from "../evidence/commands.js";
import type { EvidenceGrade } from "../qa/types.js";
import type { IntegrationDescriptor, IntegrationState } from "./integration-state.js";
import type { ReviewDepth } from "../qa/types.js";

export interface TelltailCommand {
  exe: string;
  baseArgs: string[];
  source: string;
  /** Working directory for module-aware invocations (go run). */
  cwd?: string;
}

export interface TelltailFinding {
  code: string;
  severity: number;
  summary: string;
  seq?: number;
}

export interface TelltailResult {
  grade: EvidenceGrade;
  outcome: string;
  accepted: boolean;
  findings: TelltailFinding[];
  traceHead: string;
  note: string;
}

export function shouldRunTelltail(
  depth: ReviewDepth,
  opts: { force?: boolean; behaviouralNeed?: boolean } = {},
): { run: boolean; reason: string } {
  if (opts.force) return { run: true, reason: "explicitly requested" };
  if (depth === "DEEP") return { run: true, reason: "DEEP review enables behavioural verification" };
  if (depth === "STANDARD" && opts.behaviouralNeed)
    return { run: true, reason: "STANDARD with material behavioural question" };
  return { run: false, reason: `${depth} review: Telltail gated off (no behavioural need)` };
}

async function onPath(exe: string): Promise<string | null> {
  const probe = await runCommand(process.platform === "win32" ? "where.exe" : "which", [exe], {
    timeoutMs: 10_000,
    maxChars: 1024,
  });
  if (probe.exitCode !== 0) return null;
  const first = probe.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return first ?? null;
}

/** Resolve how to invoke telltail. Pure function of environment, tested with fakes. */
export async function resolveTelltailCommand(opts: {
  repoDir?: string;
  which?: (exe: string) => Promise<string | null>;
}): Promise<TelltailCommand | null> {
  const which = opts.which ?? onPath;
  const bin = await which("telltail");
  if (bin) return { exe: bin, baseArgs: [], source: `telltail on PATH (${bin})` };
  const go = await which("go");
  const repo = opts.repoDir ?? process.env["TELLTAIL_REPO"] ?? "D:\\Projects\\Telltail";
  if (go && fs.existsSync(path.join(repo, "go.mod"))) {
    // cwd MUST be the module dir: `go run <abs>` otherwise resolves the
    // caller's module context (observed failure inside PiToRuleThemAll).
    return { exe: go, baseArgs: ["run", path.join(repo, "cmd", "telltail")], source: `go run in ${repo}`, cwd: repo };
  }
  return null;
}

export class TelltailClient {
  private state: IntegrationState = "NOT_CONFIGURED";
  private stateReason = "telltail command not resolved";
  private version: string | undefined;

  constructor(private cmd: TelltailCommand | null) {
    if (cmd) {
      this.state = "UNREACHABLE";
      this.stateReason = `resolved (${cmd.source}) but version not yet checked`;
    }
  }

  get configured(): boolean {
    return this.cmd !== null;
  }

  describe(): IntegrationDescriptor {
    return {
      name: "telltail",
      state: this.cmd ? this.state : "NOT_CONFIGURED",
      reason: this.cmd ? this.stateReason : "no telltail executable (PATH) and no Go module fallback",
      grade: this.state === "READY" ? "EXECUTED" : "UNAVAILABLE",
      version: this.version,
      executable: this.cmd ? `${this.cmd.exe} ${this.cmd.baseArgs.join(" ")}`.trim() : undefined,
    };
  }

  private async invoke(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
    if (!this.cmd) throw new Error("telltail not configured");
    return runCommand(this.cmd.exe, [...this.cmd.baseArgs, ...args], {
      cwd: opts.cwd ?? this.cmd.cwd,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  /** Smoke: the executable is real and reports its version. */
  async probe(): Promise<{ ok: boolean; version: string; detail: string }> {
    if (!this.cmd) {
      this.state = "NOT_CONFIGURED";
      return { ok: false, version: "", detail: "telltail not configured" };
    }
    const r = await this.invoke(["version"], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      this.state = "UNREACHABLE";
      this.stateReason = `telltail version failed: ${r.stderr.slice(0, 200)}`;
      return { ok: false, version: "", detail: this.stateReason };
    }
    this.version = r.stdout.trim().split("\n")[0] ?? "";
    this.state = "READY";
    this.stateReason = `telltail ${this.version} (${this.cmd.source})`;
    return { ok: true, version: this.version, detail: this.stateReason };
  }

  /** Level-1: run a worker command with process-lifecycle tracing. */
  async localRun(opts: { dir: string; worker: string; command: string; trace: string; timeoutMs?: number }) {
    if (!this.cmd) return { ok: false as const, error: "telltail not configured" };
    const r = await this.invoke(
      ["local", "run", "--dir", opts.dir, "--worker", opts.worker, "--command", opts.command, "--trace", opts.trace],
      { timeoutMs: opts.timeoutMs ?? 300_000 },
    );
    if (r.exitCode !== 0) return { ok: false as const, error: r.stdout.slice(0, 500) + r.stderr.slice(0, 500) };
    return { ok: true as const };
  }

  /** Verify a trace's append-only hash chain. */
  async traceVerify(trace: string) {
    if (!this.cmd) return { ok: false as const, error: "telltail not configured" };
    const r = await this.invoke(["trace", "verify", trace], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) return { ok: false as const, error: (r.stdout + r.stderr).slice(0, 500) };
    return { ok: true as const };
  }

  /** Analyse a trace against a scenario. The QA-of-QA step. */
  async analyze(opts: { scenario: string; trace: string; worker: string }): Promise<TelltailResult> {
    if (!this.cmd) {
      return { grade: "UNAVAILABLE", outcome: "unknown", accepted: false, findings: [], traceHead: "", note: "telltail not configured" };
    }
    const r = await this.invoke(
      ["analyze", "--scenario", opts.scenario, "--trace", opts.trace, "--worker", opts.worker, "--backend", "local"],
      { timeoutMs: 120_000 },
    );
    if (r.exitCode !== 0) {
      return {
        grade: "UNAVAILABLE",
        outcome: "unknown",
        accepted: false,
        findings: [],
        traceHead: "",
        note: `analyze failed: ${(r.stdout + r.stderr).slice(0, 300)}`,
      };
    }
    try {
      const parsed = JSON.parse(r.stdout) as {
        outcome?: string;
        accepted?: boolean;
        findings?: { code?: string; severity?: number; summary?: string; seq?: number }[];
        trace_head?: string;
        traceHead?: string;
      };
      return {
        grade: "EXECUTED",
        outcome: String(parsed.outcome ?? "unknown"),
        accepted: parsed.accepted === true,
        findings: (parsed.findings ?? []).map((f) => ({
          code: String(f.code ?? "?"),
          severity: Number(f.severity ?? 0),
          summary: String(f.summary ?? ""),
          seq: typeof f.seq === "number" ? f.seq : undefined,
        })),
        traceHead: String(parsed.trace_head ?? parsed.traceHead ?? ""),
        note: `telltail outcome: ${parsed.outcome}`,
      };
    } catch {
      return {
        grade: "UNAVAILABLE",
        outcome: "unknown",
        accepted: false,
        findings: [],
        traceHead: "",
        note: `analyze output unparsable: ${r.stdout.slice(0, 300)}`,
      };
    }
  }
}
