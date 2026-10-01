/**
 * QA receipt: build from verify pipeline outputs, persist, render compact.
 * Human display emphasises verdict/SHA/remote/failed requirements/reuse
 * findings/unknowns. Machine form is the full JSON. Never secrets, never
 * unbounded output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { QaReceipt } from "./types.js";
import { validateReceipt } from "./validate.js";

export function receiptFilePath(repoRoot: string, receiptId: string): string {
  return path.join(repoRoot, ".pi", "qa", "receipts", `${receiptId}.json`);
}

export function saveReceipt(repoRoot: string, receipt: QaReceipt): string {
  const checked = validateReceipt(receipt);
  if (!checked.ok)
    throw new Error(
      `refusing to save invalid receipt: ${checked.errors.join("; ")}`,
    );
  const file = receiptFilePath(repoRoot, receipt.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
  return file;
}

export function loadReceipt(repoRoot: string, receiptId: string): QaReceipt {
  const file = receiptFilePath(repoRoot, receiptId);
  const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  const checked = validateReceipt(doc);
  if (!checked.ok)
    throw new Error(`receipt invalid (${file}): ${checked.errors.join("; ")}`);
  return checked.receipt;
}

export function latestReceipt(repoRoot: string): QaReceipt | null {
  const dir = path.join(repoRoot, ".pi", "qa", "receipts");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let best: QaReceipt | null = null;
  for (const f of files) {
    try {
      const doc = JSON.parse(
        fs.readFileSync(path.join(dir, f), "utf-8"),
      ) as unknown;
      const checked = validateReceipt(doc);
      if (!checked.ok) continue;
      const r = checked.receipt;
      if (best === null || r.created_at > best.created_at) best = r;
    } catch {
      continue;
    }
  }
  return best;
}

/** Compact human display. Full JSON stays in the file. */
export function renderReceiptCompact(r: QaReceipt): string {
  const failed = r.verification.filter(
    (v) => v.status === "violated" || v.status === "unverified",
  );
  const lines = [
    `QA Receipt ${r.id}: ${r.verdict} (integrity ${r.integrity})`,
    `Subject: ${r.subject.branch}@${r.subject.head_sha.slice(0, 12)} remote=${r.subject.remote ?? "none"} remote_sha=${r.subject.remote_sha?.slice(0, 12) ?? "?"} verified=${r.subject.remote_verified} dirty=${r.subject.dirty ?? "?"}`,
    `Spec: ${r.intent.spec_id}#r${r.intent.spec_revision} satisfied=${r.intent.satisfied}`,
    `Tests: ${r.tests.passed}/${r.tests.executed} passed (${r.tests.failed} failed, ${r.tests.discovered} discovered)`,
  ];
  if (failed.length > 0) {
    lines.push("Failed/unverified requirements:");
    for (const f of failed)
      lines.push(`  - ${f.requirement_id}: ${f.status} [${f.evidence_grade}]`);
  }
  const reuseHits = r.reuse?.findings ?? [];
  if (reuseHits.length > 0) {
    lines.push("Reuse findings:");
    for (const h of reuseHits.slice(0, 8)) lines.push(`  - ${h}`);
  }
  if ((r.unknowns ?? []).length > 0) {
    lines.push("Unknowns:");
    for (const u of (r.unknowns ?? []).slice(0, 8)) lines.push(`  - ${u}`);
  }
  if ((r.risks ?? []).length > 0) {
    lines.push("Risks:");
    for (const k of (r.risks ?? []).slice(0, 8)) lines.push(`  - ${k}`);
  }
  const integ = r.integrations ?? {};
  const names = Object.keys(integ);
  if (names.length > 0) {
    lines.push("Integrations:");
    for (const n of names) {
      const e = integ[n];
      lines.push(
        `  - ${n}: ${e?.state} [${e?.evidence_grade}] ${e?.reason ?? ""}`.trimEnd(),
      );
    }
  }
  if ((r.stop_reasons ?? []).length > 0) {
    lines.push("Stop reasons:");
    for (const s of (r.stop_reasons ?? []).slice(0, 5)) lines.push(`  - ${s}`);
  }
  if (r.verdict === "STOP_RECOMMENDED") {
    lines.push(
      "STOP_RECOMMENDED authorises nothing. Tethers remains the authority boundary.",
    );
  }
  return lines.join("\n");
}
