/**
 * Pi adapter: registers the `qa` and `keeper` commands plus the
 * model-callable `keeper_context` / `keeper_why` tools.
 *
 * Command mapping (Pi commands are single names; subcommands travel in args):
 *   /qa preflight <request...>   freeze intent → spec revision 1
 *   /qa verify [specId] [flags]  independent verification → receipt
 *   /qa receipt [id] [--json]    compact (default) or machine-readable receipt
 *   /keeper [context <q> | why <id> | status]
 *
 * Lantern honesty: command handlers cannot invoke MCP tools directly, so
 * they report in-session Lantern tool presence (OBSERVED) and degrade
 * context retrieval to UNAVAILABLE with a pointer. The live Lantern path
 * is the model-callable keeper_* tools below, which call through
 * ctx.executeTool to Lantern's bounded MCP interface.
 */

import { Type } from "typebox";
import {
  LanternClient,
  type LanternCaller,
} from "../../src/adapters/lantern.js";
import { ReuseryClient } from "../../src/adapters/reusery.js";
import { TelltailClient } from "../../src/adapters/telltail.js";
import { TethersClient } from "../../src/adapters/tethers.js";
import type {
  PiApi,
  PiCommandContext,
  PiToolCallContext,
} from "../../src/pi-shim.js";
import {
  latestReceipt,
  loadReceipt,
  renderReceiptCompact,
} from "../../src/qa/receipt.js";
import { preflight, type PreflightInput } from "../../src/qa/preflight.js";
import { verify } from "../../src/qa/verify.js";

/** In-session Lantern MCP tool names visible to the model (any server exposing lantern_*). */
export function findLanternTools(allTools: { name: string }[]): string[] {
  return allTools.map((t) => t.name).filter((n) => /lantern/i.test(n));
}

/** Caller that routes Lantern MCP calls through ctx.executeTool (tool path only). */
export function toolContextLanternCaller(
  toolNames: string[],
  ctx: PiToolCallContext,
): LanternCaller {
  const byShort = new Map<string, string>();
  for (const full of toolNames) {
    const short = full.replace(/^mcp__[^_]+__/, "");
    byShort.set(short, full);
    byShort.set(full, full);
  }
  return {
    call: async (tool, args) => {
      const full = byShort.get(tool);
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

function parsePreflightArgs(
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

async function handleQa(
  args: string,
  ctx: PiCommandContext,
  pi: PiApi,
): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  const repoRoot = ctx.cwd;
  const lanternTools = findLanternTools(pi.getAllTools());
  // Presence is OBSERVED reachability, not data: data retrieval stays UNAVAILABLE
  // on the command path (commands cannot invoke MCP tools); the keeper_* model
  // tools are the live path.
  void lanternTools;
  const lantern = new LanternClient(null);
  const reusery = new ReuseryClient(null);
  const telltail = new TelltailClient(null);
  const tethers = new TethersClient(null);

  if (!sub || sub === "help") {
    ctx.ui.notify(
      [
        "/qa preflight <request> — freeze intent into QA spec revision 1",
        "/qa verify [specId] [--report <file>] [--claim-tests] [--require-push] [--spec-only]",
        "/qa receipt [id] [--json] — compact (default) or machine-readable receipt",
      ].join("\n"),
      "info",
    );
    return;
  }

  if (sub === "preflight") {
    const text = rest.join(" ");
    if (!text) {
      ctx.ui.notify(
        "Usage: /qa preflight <raw request> [Acceptance: ...] [Constraints: ...] [Seams: ...]",
        "error",
      );
      return;
    }
    const input = parsePreflightArgs(text);
    const report = await preflight(repoRoot, input, { lantern, reusery });
    ctx.ui.notify(report.text, "info");
    return;
  }

  if (sub === "verify") {
    const tokens = rest;
    let specId: string | undefined;
    let reportFile: string | undefined;
    let claimTests = false;
    let requirePush = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--report") {
        reportFile = tokens[++i];
      } else if (t === "--claim-tests") {
        claimTests = true;
      } else if (t === "--require-push") {
        requirePush = true;
      } else if (!t?.startsWith("--") && !specId) {
        specId = t;
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
    const outcome = await verify(
      repoRoot,
      { lantern, reusery, telltail, tethers },
      {
        specId,
        builderReport,
        builderClaimsTestsPassed: claimTests,
        requireRemotePush: requirePush,
        agentPromptPath: "agents/verifier.md",
      },
    );
    ctx.ui.notify(
      [
        renderReceiptCompact(outcome.receipt),
        `Receipt file: ${outcome.receiptFile}`,
        `Verifier isolation: separate pi process (--no-session), builder narrative withheld=${outcome.promptWithheld}`,
      ].join("\n\n"),
      outcome.receipt.verdict === "FAIL" ? "error" : "info",
    );
    return;
  }

  if (sub === "receipt") {
    const id = rest.find((t) => !t.startsWith("--"));
    const asJson = rest.includes("--json");
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

  ctx.ui.notify(`Unknown /qa subcommand '${sub}'. Use /qa help.`, "error");
}

async function handleKeeper(
  args: string,
  ctx: PiCommandContext,
  pi: PiApi,
): Promise<void> {
  const tools = findLanternTools(pi.getAllTools());
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (!sub || sub === "status") {
    ctx.ui.notify(
      tools.length > 0
        ? `Lantern: CONNECTED (OBSERVED) — tools: ${tools.join(", ")}\nLive data path: keeper_context / keeper_why model tools.`
        : "Lantern: UNAVAILABLE — no lantern_* MCP tools in this session.\nQA continues; Lantern evidence will be UNAVAILABLE, never invented.\nConnect Lantern MCP, then retry. See docs/M0-CONNECTIVITY.md.",
      tools.length > 0 ? "info" : "warning",
    );
    return;
  }
  if (sub === "context" || sub === "why") {
    if (tools.length === 0) {
      ctx.ui.notify(
        "Lantern: UNAVAILABLE — no lantern_* MCP tools in this session. Not inventing memory.",
        "warning",
      );
      return;
    }
    // Command handlers cannot invoke MCP tools; hand the live path to the model.
    ctx.ui.notify(
      `Lantern tools visible: ${tools.join(", ")}.\nAsk me to use the keeper_${sub} tool for '${rest.join(" ")}' and I will retrieve it live.`,
      "info",
    );
    return;
  }
  ctx.ui.notify(
    "Usage: /keeper [status | context <query> | why <id>]",
    "error",
  );
}

export function registerQaExtension(pi: PiApi): void {
  pi.registerCommand("qa", {
    description: "Evidence-based QA: preflight, verify, receipt",
    handler: async (args, ctx) => handleQa(args, ctx, pi),
  });
  pi.registerCommand("keeper", {
    description: "Lantern Keeper memory/provenance (bounded, never invented)",
    handler: async (args, ctx) => handleKeeper(args, ctx, pi),
  });

  const toolParams = Type.Object({ query: Type.String() });

  pi.registerTool({
    name: "keeper_context",
    label: "Keeper context",
    description:
      "Retrieve a bounded Lantern Keeper context pack (decisions, rejected paths, constraints) for a task. Live MCP path; reports UNAVAILABLE when Lantern is not connected.",
    parameters: toolParams,
    execute: async (_id, params, _signal, _update, ctx) => {
      const tools = findLanternTools(ctx.tools);
      const client = new LanternClient(
        tools.length > 0 ? toolContextLanternCaller(tools, ctx) : null,
      );
      const r = await client.context(String(params["query"] ?? ""), 8);
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
      "Provenance trail for a Lantern decision/claim id. Reports UNAVAILABLE when Lantern is not connected.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const tools = findLanternTools(ctx.tools);
      const client = new LanternClient(
        tools.length > 0 ? toolContextLanternCaller(tools, ctx) : null,
      );
      const r = await client.why(String(params["id"] ?? ""));
      return {
        content: [
          {
            type: "text",
            text: `grade=${r.grade} note=${r.note}\n${r.trail.join("\n").slice(0, 4000)}`,
          },
        ],
        details: { grade: r.grade, trail: r.trail },
      };
    },
  });
}

export default function (pi: unknown): void {
  registerQaExtension(pi as PiApi);
}
