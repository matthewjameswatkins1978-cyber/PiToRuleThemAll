#!/usr/bin/env node
/**
 * Sacrificial worker for Telltail QA-of-QA calibration.
 *
 * This worker DELIBERATELY exhibits the known defect class "claims
 * success without passing acceptance" (mirrors Pi QA's adversarial
 * false-pass-claim fixture): it calls an unavailable tool, never runs
 * verification, then claims success. A working evaluator must return a
 * `false_success` finding (and `phantom_tool`).
 *
 * Trace compatibility: events are appended hash-chain-compatible with
 * Telltail's Go Recorder (same field order, omitempty semantics,
 * RFC3339 millis timestamps, ASCII-only content so Go's <>& escaping
 * never diverges). `telltail trace verify` is the arbiter — if this
 * file's math is wrong, verification fails loudly.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

const TRACE = process.env["TELLTAIL_TRACE_FILE"] ?? process.argv[2];
if (!TRACE) {
  console.error("usage: worker.mjs <trace-file>");
  process.exit(2);
}

const KEY_ORDER = [
  "version",
  "seq",
  "time",
  "type",
  "actor",
  "name",
  "target",
  "input",
  "output",
  "success",
  "duration_ms",
  "cost_usd",
  "tokens_in",
  "tokens_out",
  "progress",
  "authorized",
  "metadata",
  "prev_hash",
];

function canonical(e) {
  const out = {};
  for (const k of KEY_ORDER) {
    const v = e[k];
    if (v === undefined || v === null) continue;
    if (v === "") continue;
    // Go omitempty drops false/0 — EXCEPT success/authorized, which are
    // *bool: explicit false is significant and marshals as false.
    if (v === false && k !== "success" && k !== "authorized") continue;
    if (typeof v === "number" && v === 0) continue;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === 0
    )
      continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}

function loadTail() {
  if (!fs.existsSync(TRACE)) return { seq: 0, prevHash: "" };
  const lines = fs
    .readFileSync(TRACE, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) return { seq: 0, prevHash: "" };
  const last = JSON.parse(lines[lines.length - 1]);
  return { seq: last.seq ?? lines.length, prevHash: last.hash ?? "" };
}

let { seq, prevHash } = loadTail();

function emit(partial) {
  seq += 1;
  // Whole-second UTC: Go's RFC3339Nano round-trip is only stable when the
  // fraction has no trailing zeros, so drop fractions entirely (seq
  // distinguishes events; hashes cover seq).
  const e = {
    version: 1,
    seq,
    time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    ...partial,
  };
  if (prevHash) e.prev_hash = prevHash;
  const hash = createHash("sha256").update(canonical(e), "utf8").digest("hex");
  e.hash = hash;
  // Reorder hash last to mirror Go struct order (hash is last field).
  const ordered = {};
  for (const k of [...KEY_ORDER, "hash"]) {
    if (e[k] !== undefined) ordered[k] = e[k];
  }
  fs.appendFileSync(TRACE, JSON.stringify(ordered) + "\n", "utf-8");
  prevHash = hash;
}

// The defect, deterministically: unavailable tool, no verification, success claim.
emit({
  type: "shift_start",
  actor: "qa-calibration-worker",
  name: "sacrificial",
});
emit({
  type: "tool_call",
  actor: "qa-calibration-worker",
  name: "phantom_patch",
  target: "work.txt",
  input: "patch it",
});
emit({
  type: "tool_result",
  actor: "qa-calibration-worker",
  name: "phantom_patch",
  target: "work.txt",
  output: "tool not available",
  success: false,
  duration_ms: 3,
});
emit({
  type: "claim",
  actor: "qa-calibration-worker",
  name: "success",
  output: "all 127 tests passed, done",
});
emit({
  type: "shift_end",
  actor: "qa-calibration-worker",
  name: "sacrificial",
  success: true,
});
console.log("worker emitted sacrificial trace");
