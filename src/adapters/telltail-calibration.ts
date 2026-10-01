/**
 * Telltail shift calibration: prove the evaluator still catches a known
 * defect TODAY. Runs the sacrificial fixture worker (which claims success
 * without verification and touches an unavailable tool), verifies the
 * trace hash chain with the real binary, and analyses it. Calibration
 * passes only when `analyze` returns the `false_success` finding.
 *
 * This is cheap (local, deterministic, no model) and runs on DEEP
 * reviews or with an explicit flag — Telltail checking the checker.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../evidence/commands.js";
import type { EvidenceGrade } from "../qa/types.js";
import type { TelltailClient } from "./telltail.js";

export interface CalibrationOutcome {
  grade: EvidenceGrade;
  calibrationPassed: boolean;
  outcome: string;
  findings: string[];
  note: string;
}

export async function runCalibration(
  repoRoot: string,
  client: TelltailClient,
): Promise<CalibrationOutcome> {
  if (!client.configured) {
    return {
      grade: "UNAVAILABLE",
      calibrationPassed: false,
      outcome: "unknown",
      findings: [],
      note: "telltail not configured",
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qa-cal-"));
  try {
    const fixtureDir = path.join(
      repoRoot,
      "fixtures",
      "telltail",
      "qa-calibration",
    );
    const scenario = path.join(fixtureDir, "scenario.json");
    const worker = path.join(fixtureDir, "worker.mjs");
    if (!fs.existsSync(scenario) || !fs.existsSync(worker)) {
      return {
        grade: "UNAVAILABLE",
        calibrationPassed: false,
        outcome: "unknown",
        findings: [],
        note: "calibration fixtures missing",
      };
    }
    const trace = path.join(dir, "shift.jsonl");
    const run = await runCommand("node", [worker, trace], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    if (run.exitCode !== 0) {
      return {
        grade: "UNAVAILABLE",
        calibrationPassed: false,
        outcome: "unknown",
        findings: [],
        note: `calibration worker failed: ${run.stderr.slice(0, 200)}`,
      };
    }
    const verified = await client.traceVerify(trace);
    if (!verified.ok) {
      return {
        grade: "UNAVAILABLE",
        calibrationPassed: false,
        outcome: "unknown",
        findings: [],
        note: `trace chain invalid: ${verified.error}`,
      };
    }
    const result = await client.analyze({
      scenario,
      trace,
      worker: "qa-calibration-worker",
    });
    if (result.grade !== "EXECUTED") {
      return {
        grade: "UNAVAILABLE",
        calibrationPassed: false,
        outcome: result.outcome,
        findings: [],
        note: result.note,
      };
    }
    const codes = result.findings.map((f) => f.code);
    const passed = codes.includes("false_success");
    return {
      grade: "EXECUTED",
      calibrationPassed: passed,
      outcome: result.outcome,
      findings: codes,
      note: passed
        ? `evaluator caught the known defect (outcome=${result.outcome}, findings=${codes.join(",")})`
        : `evaluator MISSED the known defect (outcome=${result.outcome}, findings=${codes.join(",") || "none"})`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
