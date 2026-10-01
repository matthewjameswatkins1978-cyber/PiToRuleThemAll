/**
 * Tethers adapter (§29/M5, tethers-lang — never the hq prototype).
 * Pi QA is READ-ONLY with respect to authority:
 * - it may ask (describe state, run an explicit check/preview/plan when
 *   given a config+engine), and it may REPORT a STOP_RECOMMENDED;
 * - there is deliberately no `authorise()` method, and no QA verdict
 *   ever becomes permission.
 *
 * Discovery: `tethers` on PATH, else the known local install. `describe
 * --json` proves the boundary exists. `check`/`preview`/`plan` run only
 * with explicit caller-supplied config (and engine/input) paths — QA
 * never invents authority configuration.
 */

import { runCommand } from "../evidence/commands.js";
import type { EvidenceGrade } from "../qa/types.js";
import type { IntegrationDescriptor, IntegrationState } from "./integration-state.js";

export interface StopRecommendation {
  reason: string;
  evidence: string[];
  specId: string;
  receiptId: string;
}

export interface AuthorityState {
  /** What the authority boundary says, if reachable. */
  decision: "ALLOW" | "ASK" | "DENY" | "UNAVAILABLE";
  note: string;
}

const KNOWN_INSTALLS = [
  "C:\\Users\\Matmus\\AppData\\Local\\Programs\\Tethers\\0.8.0\\bin\\tethers.exe",
];

export async function resolveTethersCommand(opts: {
  which?: (exe: string) => Promise<string | null>;
} = {}): Promise<{ exe: string; source: string } | null> {
  const which =
    opts.which ??
    (async (exe: string) => {
      const probe = await runCommand(process.platform === "win32" ? "where.exe" : "which", [exe], {
        timeoutMs: 10_000,
        maxChars: 1024,
      });
      if (probe.exitCode !== 0) return null;
      return probe.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? null;
    });
  const bin = await which("tethers");
  if (bin) return { exe: bin, source: `tethers on PATH (${bin})` };
  const fs = await import("node:fs");
  for (const cand of KNOWN_INSTALLS) {
    try {
      if (fs.existsSync(cand)) return { exe: cand, source: `known install (${cand})` };
    } catch {
      continue;
    }
  }
  return null;
}

export class TethersClient {
  private state: IntegrationState = "NOT_CONFIGURED";
  private stateReason = "tethers CLI not resolved";
  private version: string | undefined;

  constructor(private cmd: { exe: string; source: string } | null) {
    if (cmd) {
      this.state = "UNREACHABLE";
      this.stateReason = `resolved (${cmd.source}) but describe not yet run`;
    }
  }

  get configured(): boolean {
    return this.cmd !== null;
  }

  describe(): IntegrationDescriptor {
    return {
      name: "tethers",
      state: this.cmd ? this.state : "NOT_CONFIGURED",
      reason: this.cmd ? this.stateReason : "no tethers CLI (PATH or known install)",
      grade: this.state === "READY" ? "EXECUTED" : "UNAVAILABLE",
      version: this.version,
      executable: this.cmd?.exe,
    };
  }

  /** Read-only discovery: proves the boundary exists. No authority moved. */
  async probe(): Promise<{ ok: boolean; version: string; detail: string }> {
    if (!this.cmd) {
      this.state = "NOT_CONFIGURED";
      return { ok: false, version: "", detail: "tethers CLI not resolved" };
    }
    const r = await runCommand(this.cmd.exe, ["describe", "--json"], { timeoutMs: 30_000, maxChars: 8192 });
    if (r.exitCode !== 0) {
      this.state = "UNREACHABLE";
      this.stateReason = `tethers describe failed: ${r.stderr.slice(0, 200)}`;
      return { ok: false, version: "", detail: this.stateReason };
    }
    try {
      const parsed = JSON.parse(r.stdout) as { data?: { version?: string } };
      this.version = String(parsed.data?.version ?? "");
    } catch {
      this.version = "";
    }
    this.state = "READY";
    this.stateReason = `authority boundary present (tethers ${this.version}, ${this.cmd.source})`;
    return { ok: true, version: this.version, detail: this.stateReason };
  }

  /**
   * Explicit authority evaluation. Runs ONLY with caller-supplied
   * config/engine/input — QA never invents them, and a missing triple
   * yields UNAVAILABLE (never self-authorization).
   */
  async evaluate(opts: {
    mode: "check" | "preview" | "plan";
    config: string;
    engine?: string;
    input?: string;
    hostDataRoot?: string;
  }): Promise<AuthorityState> {
    if (!this.cmd) return { decision: "UNAVAILABLE", note: "tethers CLI not resolved" };
    if (!opts.config || (opts.mode !== "check" && (!opts.engine || !opts.input))) {
      return { decision: "UNAVAILABLE", note: `${opts.mode} needs explicit config${opts.mode === "check" ? "" : "/engine/input"}; QA does not invent authority configuration` };
    }
    const args = [opts.mode, "--config", opts.config];
    if (opts.engine) args.push("--engine", opts.engine);
    if (opts.input) args.push("--input", opts.input);
    if (opts.hostDataRoot) args.push("--host-data-root", opts.hostDataRoot);
    const r = await runCommand(this.cmd.exe, args, { timeoutMs: 60_000, maxChars: 8192 });
    const text = `${r.stdout}\n${r.stderr}`.toUpperCase();
    const decision = /\bDENY\b/.test(text) ? "DENY" : /\bASK\b/.test(text) ? "ASK" : r.exitCode === 0 ? "ALLOW" : "UNAVAILABLE";
    return {
      decision,
      note: `tethers ${opts.mode} exit=${r.exitCode} → ${decision}; QA recommendation unchanged, nothing authorised by QA`,
    };
  }

  /** Package a stop recommendation with its evidence for Matthew/Tethers. */
  packageStop(rec: StopRecommendation): { grade: EvidenceGrade; text: string } {
    const lines = [
      `STOP_RECOMMENDED (${rec.receiptId}, spec ${rec.specId})`,
      `Reason: ${rec.reason}`,
      `Evidence:`,
      ...rec.evidence.map((e) => `  - ${e}`),
      `This recommendation authorises nothing. Tethers remains the authority boundary.`,
    ];
    return { grade: "EXECUTED", text: lines.join("\n") };
  }
}
