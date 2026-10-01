/**
 * /qa doctor (§24). Compact integration diagnostics so Matthew never has
 * to think about plumbing. Every row is a live probe result, not a guess:
 * READY (works now), UNAVAILABLE (missing with reason), MISCONFIGURED
 * (present but broken), OPTIONAL (by design, e.g. Reusery DB).
 *
 * No model calls. The verifier smoke behind `--smoke` is the only
 * exception and is explicitly flagged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../evidence/commands.js";
import type { IntegrationRegistry } from "../adapters/registry.js";
import { StdioMcpClient } from "../adapters/transports/stdio-mcp.js";
import { resolveAstGrep } from "../reuse/tool-discovery.js";
import { latestReceipt } from "../crossclient/proof.js";

export type DoctorState =
  | "READY"
  | "UNAVAILABLE"
  | "MISCONFIGURED"
  | "OPTIONAL"
  | "NOT_CONFIGURED"
  | "PENDING_USER"
  | "VERIFIED";

export interface DoctorRow {
  name: string;
  state: DoctorState;
  detail: string;
}

async function versionOf(
  exe: string,
  args: string[] = ["--version"],
): Promise<string | null> {
  const r = await runCommand(exe, args, { timeoutMs: 15_000, maxChars: 512 });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim().split("\n")[0] ?? null;
}

export async function doctor(opts: {
  registry: IntegrationRegistry;
  smokeVerifier?: () => Promise<{ ok: boolean; detail: string }>;
  repoRoot?: string;
}): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const described = new Map(
    opts.registry.describeAll().map((d) => [d.name, d]),
  );

  const pi = await versionOf("pi");
  rows.push({
    name: "Pi",
    state: pi ? "READY" : "MISCONFIGURED",
    detail: pi ?? "pi binary not responding to --version",
  });

  const git = await versionOf("git");
  rows.push({
    name: "Git",
    state: git ? "READY" : "MISCONFIGURED",
    detail: git ?? "git missing",
  });

  const gh = await runCommand("gh", ["auth", "status"], {
    timeoutMs: 15_000,
    maxChars: 512,
  });
  const ghOk = gh.exitCode === 0;
  rows.push({
    name: "GitHub",
    state: ghOk ? "READY" : "UNAVAILABLE",
    detail: ghOk
      ? "gh authenticated"
      : "gh auth missing or unreachable; remote verification unavailable",
  });

  const rg = await versionOf("rg");
  rows.push({
    name: "rg",
    state: rg ? "READY" : "MISCONFIGURED",
    detail: rg ?? "rg missing (text reuse search unavailable)",
  });

  const ag = await resolveAstGrep();
  if (ag) {
    const v = await versionOf(ag.exe, ["--version"]);
    rows.push({
      name: "ast-grep",
      state: "READY",
      detail: `${ag.source}${v ? ` — ${v}` : ""}`,
    });
  } else {
    rows.push({
      name: "ast-grep",
      state: "UNAVAILABLE",
      detail: "neither sg nor ast-grep on PATH",
    });
  }

  const lan = described.get("lantern");
  rows.push({
    name: "Lantern",
    state:
      lan?.state === "READY"
        ? "READY"
        : lan?.state === "UNREACHABLE"
          ? "MISCONFIGURED"
          : "UNAVAILABLE",
    detail: lan?.reason ?? "unknown",
  });

  // Probe, don't just describe: doctor pays for one live version call each.
  const ttProbe = await opts.registry.telltail
    .probe()
    .catch(() => ({ ok: false as const, version: "", detail: "probe threw" }));
  rows.push({
    name: "Telltail",
    state: ttProbe.ok ? "READY" : "UNAVAILABLE",
    detail: ttProbe.ok ? `telltail ${ttProbe.version}` : ttProbe.detail,
  });

  // Prove Reusery wiring with a read-only catalog call (cheap, local DB).
  const rePing = await opts.registry.reusery
    .ping()
    .catch(() => ({ ok: false as const, primitives: 0, note: "ping threw" }));
  rows.push({
    name: "Reusery",
    state: rePing.ok ? "READY" : "OPTIONAL",
    detail: rePing.ok
      ? `catalog: ${rePing.primitives} primitives`
      : rePing.note,
  });

  const thProbe = await opts.registry.tethers
    .probe()
    .catch(() => ({ ok: false as const, version: "", detail: "probe threw" }));
  rows.push({
    name: "Tethers",
    state: thProbe.ok ? "READY" : "UNAVAILABLE",
    detail: thProbe.ok
      ? `authority boundary present (tethers ${thProbe.version})`
      : thProbe.detail,
  });

  // M6: ChatGPT bridge readiness is separate from Lantern readiness.
  // READY means the Desktop config exists and the bridge process starts —
  // never that ChatGPT has consumed anything.
  const chatgpt = await checkChatGptBridge();
  rows.push({
    name: "ChatGPT bridge",
    state: chatgpt.state,
    detail: chatgpt.detail,
  });
  if (opts.repoRoot) {
    const cross = readCrossClientState(opts.repoRoot);
    rows.push({
      name: "Cross-client",
      state: cross.state,
      detail: cross.detail,
    });
  }

  if (opts.smokeVerifier) {
    const smoke = await opts.smokeVerifier();
    rows.push({
      name: "Verifier",
      state: smoke.ok ? "READY" : "MISCONFIGURED",
      detail: smoke.detail,
    });
  } else {
    rows.push({
      name: "Verifier",
      state: "READY",
      detail: "pi binary present; live smoke needs /qa doctor --smoke",
    });
  }
  return rows;
}

/**
 * M6 ChatGPT bridge check: the Desktop/Codex app config contains a
 * Lantern stdio entry pointing at an existing bridge binary, AND the
 * bridge process completes an initialize handshake. Says nothing about
 * ChatGPT having consumed anything.
 */
export async function checkChatGptBridge(
  opts: { configPath?: string } = {},
): Promise<{
  state: DoctorState;
  detail: string;
}> {
  const configPath =
    opts.configPath ?? path.join(os.homedir(), ".codex", "config.toml");
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    return {
      state: "NOT_CONFIGURED",
      detail: `no Desktop config at ${configPath}`,
    };
  }
  const section = /\[mcp_servers\.lantern\]([^\[]*)/.exec(text)?.[1] ?? "";
  if (!section)
    return {
      state: "NOT_CONFIGURED",
      detail: "no [mcp_servers.lantern] entry in Desktop config",
    };
  const command = /command\s*=\s*['"]([^'"]+)['"]/.exec(section)?.[1];
  if (!command)
    return {
      state: "MISCONFIGURED",
      detail: "[mcp_servers.lantern] has no command",
    };
  if (!fs.existsSync(command)) {
    return {
      state: "MISCONFIGURED",
      detail: `bridge binary missing: ${command}`,
    };
  }
  const client = new StdioMcpClient({
    command,
    args: ["mcp"],
    timeoutMs: 30_000,
  });
  try {
    await client.start();
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    const wanted = [
      "lantern_status",
      "lantern_search",
      "lantern_context",
      "lantern_why",
    ];
    const missing = wanted.filter((w) => !names.includes(w));
    if (missing.length > 0)
      return {
        state: "MISCONFIGURED",
        detail: `bridge up but missing: ${missing.join(", ")}`,
      };
    return { state: "READY", detail: `config + bridge start OK (${command})` };
  } catch (e) {
    return {
      state: "UNAVAILABLE",
      detail: `bridge failed to start: ${(e as Error).message.slice(0, 160)}`,
    };
  } finally {
    await client.stop();
  }
}

/** Cross-client state from the latest proof receipt (never inferred). */
export function readCrossClientState(repoRoot: string): {
  state: DoctorState;
  detail: string;
} {
  let receipt = null;
  try {
    receipt = latestReceipt(repoRoot);
  } catch {
    receipt = null;
  }
  if (!receipt)
    return {
      state: "UNAVAILABLE",
      detail: "no proof marker yet — run /keeper proof",
    };
  if (receipt.chatgpt.status === "VERIFIED") {
    return { state: "VERIFIED", detail: `Lucy confirmed ${receipt.memory_id}` };
  }
  return {
    state: "PENDING_USER",
    detail: `waiting on Lucy for ${receipt.marker} (${receipt.memory_id})`,
  };
}

export function renderDoctor(rows: DoctorRow[]): string {
  const width = Math.max(...rows.map((r) => r.name.length));
  return rows
    .map((r) => `${r.name.padEnd(width)}  ${r.state.padEnd(13)} ${r.detail}`)
    .join("\n");
}
