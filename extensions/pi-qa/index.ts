/**
 * Pi adapter: `qa` and `keeper` commands + `keeper_context`/`keeper_why`
 * model tools.
 *
 * Architecture (§11 — recorded decision): Pi's command context genuinely
 * cannot invoke nested tools (ExtensionCommandContext has no
 * executeTool; verified against Pi 0.99.2 types), so commands reach live
 * integrations through the SAME supported surfaces the systems
 * themselves document: Lantern/Reusery stdio MCP bridges (spawns the
 * real servers, speaks spec JSON-RPC), Telltail/Tethers CLIs. No model
 * round-trip is spent on deterministic work; no MCP implementation is
 * hand-rolled beyond the stdio transport both servers document.
 * Model-callable keeper_* tools use the native ctx.executeTool path to
 * in-session Lantern MCP tools.
 *
 * Command mapping:
 *   /qa preflight <raw request, newlines preserved>
 *   /qa verify [specId] [--report "path"] [--claim-tests] [--require-push]
 *             [--telltail] [--reusery] [--spec-only]
 *   /qa receipt [id] [--json]
 *   /qa doctor [--smoke]
 *   /keeper [status | context <query> | why <id>]
 */

import { Type } from "typebox";
import { LANTERN_TOOLS } from "../../src/adapters/lantern.js";
import {
  createRegistry,
  type IntegrationRegistry,
} from "../../src/adapters/registry.js";
import { doctor, renderDoctor } from "../../src/qa/doctor.js";
import {
  latestReceipt,
  loadReceipt,
  renderReceiptCompact,
} from "../../src/qa/receipt.js";
import { preflight, type PreflightInput } from "../../src/qa/preflight.js";
import { verify } from "../../src/qa/verify.js";
import type {
  PiApi,
  PiCommandContext,
  PiToolCallContext,
} from "../../src/pi-shim.js";

/**
 * Match a registered Pi tool name to a Lantern MCP tool by KNOWN SUFFIX.
 * Splits on double underscores (Pi's namespace separator), so single
 * underscores inside server names are safe:
 *   mcp__lantern__lantern_status        → lantern_status
 *   mcp__lantern_keeper__lantern_status → lantern_status
 *   lantern_status                      → lantern_status
 */
export function matchLanternTool(
  registeredName: string,
  short: string,
): boolean {
  const suffix = registeredName.split("__").pop() ?? registeredName;
  return suffix === short;
}

export function findLanternTools(allTools: { name: string }[]): string[] {
  const shorts = new Set<string>(LANTERN_TOOLS as unknown as string[]);
  return allTools
    .map((t) => t.name)
    .filter((n) => shorts.has(n.split("__").pop() ?? n));
}

/** Caller routing Lantern calls through ctx.executeTool (tool path only). */
export function toolContextLanternCaller(
  toolNames: string[],
  ctx: PiToolCallContext,
): {
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
} {
  return {
    call: async (tool, args) => {
      const full = toolNames.find((n) => matchLanternTool(n, tool));
      if (!full)
        return {
          ok: false,
          error: `Lantern tool '${tool}' not connected in this session`,
        };
      try {
        const out = await ctx.executeTool(full, args);
        if (out.isError)
          return { ok: false, error: "lantern tool returned isError" };
        const text = out.result.content
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("\n");
        try {
          return { ok: true, data: JSON.parse(text) as unknown };
        } catch {
          return { ok: true, data: { text } };
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

/**
 * Minimal quoted-argument splitter (defect M). Handles Windows paths:
 *   --report "D:\Some Folder\final report.txt" --require-push
 * → ["--report", "D:\\Some Folder\\final report.txt", "--require-push"]
 * Supports double quotes (no escape processing beyond \"\" → " is NOT
 * needed; backslashes stay literal so Windows paths survive).
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      hasToken = true;
    } else if (ch === '"') {
      inQuotes = true;
      hasToken = true;
    } else if (/\s/.test(ch ?? "")) {
      if (hasToken) {
        out.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) out.push(cur);
  return out;
}

export function parsePreflightArgs(
  raw: string,
): Omit<PreflightInput, "normalizedIntent"> & { normalizedIntent: string } {
  const lines = raw.split("\n");
  const requestLines: string[] = [];
  const acceptance: { id: string; requirement: string }[] = [];
  const constraints: string[] = [];
  let seams: string[] = [];
  let section: "request" | "acceptance" | "constraints" | "seams" = "request";
  for (const line of lines) {
    const t = line.trim();
    if (/^acceptance:/i.test(t)) {
      section = "acceptance";
      continue;
    }
    if (/^constraints:/i.test(t)) {
      section = "constraints";
      continue;
    }
    if (/^seams:/i.test(t)) {
      const rest = t.slice("seams:".length).trim();
      if (rest) seams = rest.split(/[,\s]+/).filter(Boolean);
      section = "seams";
      continue;
    }
    if (section === "request") requestLines.push(line);
    else if (section === "acceptance" && /^[-*]\s+/.test(t)) {
      const body = t.replace(/^[-*]\s+/, "");
      const m = /^(A\d+):\s*(.+)$/.exec(body);
      acceptance.push(
        m
          ? {
              id: m[1] ?? `A${acceptance.length + 1}`,
              requirement: m[2] ?? body,
            }
          : { id: `A${acceptance.length + 1}`, requirement: body },
      );
    } else if (section === "constraints" && /^[-*]\s+/.test(t)) {
      constraints.push(t.replace(/^[-*]\s+/, ""));
    } else if (section === "seams" && /^[-*]\s+/.test(t)) {
      seams.push(t.replace(/^[-*]\s+/, ""));
    }
  }
  const rawRequest = requestLines.join("\n").trim() || raw.trim();
  if (acceptance.length === 0) {
    acceptance.push({
      id: "A1",
      requirement: rawRequest.slice(0, 500) || "(empty request)",
    });
  }
  return {
    rawRequest,
    normalizedIntent: rawRequest,
    acceptance,
    constraints,
    consequentialSeams: seams,
  };
}

export type RegistryFactory = (cwd: string) => Promise<IntegrationRegistry>;

async function withRegistry<T>(
  cwd: string,
  fn: (reg: IntegrationRegistry) => Promise<T>,
  factory: RegistryFactory = createRegistry,
): Promise<T> {
  const reg = await factory(cwd);
  try {
    return await fn(reg);
  } finally {
    // Sessions are closed by their users; registry-level clients are stateless.
  }
}

export async function handleQa(
  args: string,
  ctx: PiCommandContext,
  pi: PiApi,
  factory: RegistryFactory = createRegistry,
): Promise<void> {
  // Defect L: never tokenize the whole request. Split off the subcommand
  // verb, then handle each subcommand's raw remainder appropriately.
  const verbMatch = /^\s*(\S+)([\s\S]*)$/.exec(args);
  const sub = (verbMatch?.[1] ?? "").toLowerCase();
  const rest = verbMatch?.[2] ?? "";
  const repoRoot = ctx.cwd;

  if (!sub || sub === "help") {
    ctx.ui.notify(
      [
        "/qa preflight <request> — freeze intent into QA spec revision 1 (multiline ok)",
        '/qa verify [specId] [--report "path"] [--claim-tests] [--require-push] [--telltail] [--reusery] [--spec-only]',
        "/qa receipt [id] [--json] — compact (default) or machine-readable receipt",
        "/qa doctor [--smoke] — integration diagnostics",
      ].join("\n"),
      "info",
    );
    return;
  }

  if (sub === "preflight") {
    const text = rest.replace(/^\s+/, "");
    if (!text) {
      ctx.ui.notify(
        "Usage: /qa preflight <raw request> [Acceptance: ...] [Constraints: ...] [Seams: ...]",
        "error",
      );
      return;
    }
    const input = parsePreflightArgs(text);
    await withRegistry(
      repoRoot,
      async (reg) => {
        const session = await reg.lanternSession();
        try {
          const report = await preflight(repoRoot, input, {
            lantern: session ? session.client : reg.lantern,
            reusery: reg.reusery,
          });
          ctx.ui.notify(report.text, "info");
        } finally {
          await session?.close();
        }
      },
      factory,
    );
    return;
  }

  if (sub === "verify") {
    const tokens = splitArgs(rest);
    let specId: string | undefined;
    let reportFile: string | undefined;
    let claimTests = false;
    let requirePush = false;
    let telltail = false;
    let reusery = false;
    let specOnly = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--report") {
        reportFile = tokens[++i];
      } else if (t === "--claim-tests") {
        claimTests = true;
      } else if (t === "--require-push") {
        requirePush = true;
      } else if (t === "--telltail") {
        telltail = true;
      } else if (t === "--reusery") {
        reusery = true;
      } else if (t === "--spec-only") {
        specOnly = true;
      } else if (!t?.startsWith("--") && !specId) {
        specId = t;
      } else {
        ctx.ui.notify(`Unknown /qa verify flag '${t}'. Use /qa help.`, "error");
        return;
      }
    }
    let builderReport: string | null = null;
    if (reportFile) {
      const { readFileSync } = await import("node:fs");
      try {
        builderReport = readFileSync(reportFile, "utf-8");
      } catch {
        ctx.ui.notify(`Cannot read builder report: ${reportFile}`, "error");
        return;
      }
    }
    await withRegistry(
      repoRoot,
      async (reg) => {
        const session = await reg.lanternSession();
        try {
          const outcome = await verify(
            repoRoot,
            {
              lantern: session ? session.client : reg.lantern,
              reusery: reg.reusery,
              telltail: reg.telltail,
              tethers: reg.tethers,
            },
            {
              specId,
              builderReport,
              builderClaimsTestsPassed: claimTests,
              requireRemotePush: requirePush,
              telltail,
              reusery,
              specOnly,
              agentPromptPath: "agents/verifier.md",
            },
          );
          ctx.ui.notify(
            [
              renderReceiptCompact(outcome.receipt),
              `Receipt file: ${outcome.receiptFile}`,
              `Verifier isolation: fresh pi process (--no-session), builder narrative withheld=${outcome.promptWithheld}`,
            ].join("\n\n"),
            outcome.receipt.verdict === "FAIL" ? "error" : "info",
          );
        } finally {
          await session?.close();
        }
      },
      factory,
    );
    return;
  }

  if (sub === "receipt") {
    const tokens = splitArgs(rest);
    const id = tokens.find((t) => !t.startsWith("--"));
    const asJson = tokens.includes("--json");
    const r = id ? loadReceipt(repoRoot, id) : latestReceipt(repoRoot);
    if (!r) {
      ctx.ui.notify("No QA receipts yet. Run /qa verify first.", "error");
      return;
    }
    ctx.ui.notify(
      asJson ? JSON.stringify(r, null, 2) : renderReceiptCompact(r),
      "info",
    );
    return;
  }

  if (sub === "doctor") {
    const smoke = splitArgs(rest).includes("--smoke");
    await withRegistry(
      repoRoot,
      async (reg) => {
        const rows = await doctor({
          registry: reg,
          smokeVerifier: smoke
            ? async () => {
                const { runIndependentReview } =
                  await import("../../src/qa/independent-review.js");
                try {
                  const r = await runIndependentReview(
                    repoRoot,
                    {
                      spec: { id: "doctor-smoke" },
                      trustedRules: { ref: "smoke", files: {} },
                      snapshot: {},
                      diff: { files: [], text: "", truncated: false },
                      testEvidence: {},
                      reuseEvidence: {},
                      lanternPack: {},
                      agentPromptPath: "agents/verifier.md",
                    },
                    { timeoutMs: 300_000 },
                  );
                  void r;
                  return {
                    ok: true,
                    detail: "fresh pi --no-session process completed",
                  };
                } catch (e) {
                  return {
                    ok: false,
                    detail: `verifier smoke failed: ${(e as Error).message}`,
                  };
                }
              }
            : undefined,
        });
        ctx.ui.notify(renderDoctor(rows), "info");
      },
      factory,
    );
    return;
  }

  ctx.ui.notify(`Unknown /qa subcommand '${sub}'. Use /qa help.`, "error");
}

export async function handleKeeper(
  args: string,
  ctx: PiCommandContext,
  pi: PiApi,
  factory: RegistryFactory = createRegistry,
): Promise<void> {
  const verbMatch = /^\s*(\S+)([\s\S]*)$/.exec(args);
  const sub = (verbMatch?.[1] ?? "").toLowerCase() || "status";
  const rest = (verbMatch?.[2] ?? "").trim();
  void pi;

  if (sub === "status") {
    const reg = await factory(ctx.cwd);
    const lan = reg.lantern.describe();
    const lines = [
      lan.state === "READY"
        ? `Lantern: READY (EXECUTED) — ${lan.reason}`
        : `Lantern: ${lan.state} — ${lan.reason}`,
      `Reusery: ${reg.reusery.describe().state} — ${reg.reusery.describe().reason}`,
      `Telltail: ${reg.telltail.describe().state} — ${reg.telltail.describe().reason}`,
      `Tethers: ${reg.tethers.describe().state} — ${reg.tethers.describe().reason}`,
    ];
    ctx.ui.notify(lines.join("\n"), lan.state === "READY" ? "info" : "warning");
    return;
  }

  // One-action workflows (defect F): open a real session, look up, report.
  if (sub === "context") {
    if (!rest) {
      ctx.ui.notify("Usage: /keeper context <query>", "error");
      return;
    }
    const reg = await factory(ctx.cwd);
    const session = await reg.lanternSession();
    if (!session) {
      ctx.ui.notify(
        `Lantern: ${reg.lantern.describe().state} — ${reg.lantern.describe().reason}. Not inventing memory.`,
        "warning",
      );
      return;
    }
    try {
      const r = await session.client.context(rest, {
        itemBudget: 8,
        tokenBudget: 2000,
      });
      if (r.grade !== "EXECUTED") {
        ctx.ui.notify(`Lantern: UNAVAILABLE — ${r.note}`, "warning");
        return;
      }
      const p = r.pack;
      const lines = [
        `Lantern context pack ${p.id ?? "(no id)"} [EXECUTED]`,
        ...p.decisions
          .slice(0, 8)
          .map((d) => `- decision ${d.id}: ${d.summary}`),
        ...p.rejectedPaths.slice(0, 5).map((c) => `- rejected: ${c}`),
        ...p.negativeConstraints.slice(0, 5).map((c) => `- constraint: ${c}`),
        ...(p.provenance.length > 0
          ? [`provenance: ${p.provenance.slice(0, 8).join(", ")}`]
          : []),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    } finally {
      await session.close();
    }
    return;
  }

  if (sub === "why") {
    if (!rest) {
      ctx.ui.notify("Usage: /keeper why <memory|belief id>", "error");
      return;
    }
    const reg = await factory(ctx.cwd);
    const session = await reg.lanternSession();
    if (!session) {
      ctx.ui.notify(
        `Lantern: ${reg.lantern.describe().state} — ${reg.lantern.describe().reason}. Not inventing memory.`,
        "warning",
      );
      return;
    }
    try {
      const id = rest.split(/\s+/)[0] ?? rest;
      const r = await session.client.why({ memory_id: id });
      if (!r.ok) {
        ctx.ui.notify(`Lantern: UNAVAILABLE — ${r.error}`, "warning");
        return;
      }
      ctx.ui.notify(
        r.trail.length > 0
          ? `Provenance for ${id} [EXECUTED]:\n${r.trail.map((t) => `- ${t}`).join("\n")}`
          : `No provenance trail for ${id}.`,
        "info",
      );
    } finally {
      await session.close();
    }
    return;
  }

  ctx.ui.notify(
    "Usage: /keeper [status | context <query> | why <id>]",
    "error",
  );
}

export function registerQaExtension(pi: PiApi): void {
  pi.registerCommand("qa", {
    description: "Evidence-based QA: preflight, verify, receipt, doctor",
    handler: async (args, ctx) => handleQa(args, ctx, pi),
  });
  pi.registerCommand("keeper", {
    description: "Lantern Keeper memory/provenance (bounded, never invented)",
    handler: async (args, ctx) => handleKeeper(args, ctx, pi),
  });

  pi.registerTool({
    name: "keeper_context",
    label: "Keeper context",
    description:
      "Retrieve a bounded Lantern Keeper context pack (decisions, rejected paths, constraints) for a task. Live MCP path; reports UNAVAILABLE when Lantern is not connected.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const { LanternClient } = await import("../../src/adapters/lantern.js");
      const tools = findLanternTools(ctx.tools);
      const client = new LanternClient(
        tools.length > 0 ? toolContextLanternCaller(tools, ctx) : null,
      );
      const r = await client.context(String(params["query"] ?? ""), {
        itemBudget: 8,
        tokenBudget: 2000,
      });
      return {
        content: [
          {
            type: "text",
            text: `grade=${r.grade} pack=${r.pack.id ?? "none"} note=${r.note}\n${JSON.stringify(r.pack, null, 2).slice(0, 4000)}`,
          },
        ],
        details: { grade: r.grade, pack: r.pack },
      };
    },
  });

  pi.registerTool({
    name: "keeper_why",
    label: "Keeper why",
    description:
      "Provenance trail for a Lantern memory/belief id. Reports UNAVAILABLE when Lantern is not connected.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const { LanternClient } = await import("../../src/adapters/lantern.js");
      const tools = findLanternTools(ctx.tools);
      const client = new LanternClient(
        tools.length > 0 ? toolContextLanternCaller(tools, ctx) : null,
      );
      const r = await client.why({ memory_id: String(params["id"] ?? "") });
      return {
        content: [
          {
            type: "text",
            text: `ok=${r.ok} note=${r.error ?? "provenance retrieved"}\n${r.trail.join("\n").slice(0, 4000)}`,
          },
        ],
        details: { ok: r.ok, trail: r.trail },
      };
    },
  });
}

export default function (pi: unknown): void {
  registerQaExtension(pi as PiApi);
}
