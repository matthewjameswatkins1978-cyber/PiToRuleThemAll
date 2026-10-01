/**
 * IntegrationRegistry (§31). One small typed composition object, created
 * once at the Pi boundary (per command invocation) and injected into
 * core QA. No DI framework. No null callers scattered through
 * user-facing code: each integration resolves to READY-with-a-session
 * or to an explicit degraded client carrying its reason.
 *
 * Lifecycle: stdio bridge processes are session-scoped (start → use →
 * stop). The extension opens a session, runs the pipeline, closes it.
 * Core QA never sees transports.
 *
 * Secrets (REUSERY_DATABASE_URL etc.) come from the environment only.
 * This file has no defaults for credentials.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LanternClient, type LanternCaller } from "./lantern.js";
import { ReuseryClient, type ReuseryMcp } from "./reusery.js";
import { TelltailClient, resolveTelltailCommand } from "./telltail.js";
import { TethersClient, resolveTethersCommand } from "./tethers.js";
import { StdioMcpClient } from "./transports/stdio-mcp.js";
import type { IntegrationDescriptor } from "./integration-state.js";

export interface RegistryEnv {
  PI_QA_LANTERN_BIN?: string;
  PI_QA_LANTERN_URL?: string;
  PI_QA_REUSERY_BIN?: string;
  REUSERY_DATABASE_URL?: string;
  TELLTAIL_REPO?: string;
  [key: string]: string | undefined;
}

export interface LanternSession {
  client: LanternClient;
  close(): Promise<void>;
}

const DEFAULT_LANTERN_BIN =
  "D:\\Projects\\lantern-keeper\\target\\debug\\lighting.exe";
const DEFAULT_REUSERY_BIN = "C:\\Users\\Matmus\\.pi\\agent\\bin\\reusery.exe";
const DEFAULT_TELLTAIL_REPO = "D:\\Projects\\Telltail";

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

async function serveReady(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${url.replace(/\/$/, "")}/health/ready`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return false;
    const body = (await r.json()) as { ready?: boolean };
    return body.ready === true;
  } catch {
    // Fall back to TCP: some runtimes (including Pi's extension host)
    // restrict global fetch, while the local port is genuinely open.
    // The bridge's own lantern_status gives the authoritative answer.
    return tcpOpen(url, timeoutMs);
  }
}

function tcpOpen(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 4317;
    try {
      const u = new URL(url);
      host = u.hostname || host;
      port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch {
      resolve(false);
      return;
    }
    import("node:net")
      .then(({ default: net }) => {
        const sock = net.createConnection({ host, port });
        const done = (ok: boolean) => {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        sock.on("connect", () => {
          clearTimeout(timer);
          done(true);
        });
        sock.on("error", () => {
          clearTimeout(timer);
          done(false);
        });
      })
      .catch(() => resolve(false));
  });
}

function mcpCaller(
  client: StdioMcpClient,
  missingToolHint: string,
): LanternCaller & { close(): Promise<void> } {
  void missingToolHint;
  return {
    call: async (tool, args) => {
      try {
        const data = await client.callTool<unknown>(tool, args);
        return { ok: true, data };
      } catch (e) {
        const msg = (e as Error).message;
        return {
          ok: false,
          error: /unknown tool/i.test(msg) ? `TOOL_MISSING: ${msg}` : msg,
        };
      }
    },
    close: () => client.stop(),
  };
}

class StdioReuseryMcp implements ReuseryMcp {
  constructor(
    private bin: string,
    private dbUrl: string,
    private projectRoot: string,
  ) {}

  private async withClient<T>(
    fn: (c: StdioMcpClient) => Promise<T>,
  ): Promise<T> {
    const c = new StdioMcpClient({
      command: this.bin,
      args: ["mcp", "--project-root", this.projectRoot],
      env: { REUSERY_DATABASE_URL: this.dbUrl },
      timeoutMs: 60_000,
    });
    await c.start();
    try {
      return await fn(c);
    } finally {
      await c.stop();
    }
  }

  async catalog() {
    try {
      const data = await this.withClient((c) =>
        c.callTool<{
          primitives?: {
            primitive_id: string;
            contract_id: string;
            name: string;
            description: string;
          }[];
        }>("reusery_catalog", {}),
      );
      return { ok: true as const, primitives: data.primitives ?? [] };
    } catch (e) {
      return {
        ok: false as const,
        primitives: [],
        error: (e as Error).message,
      };
    }
  }

  async resolve(
    primitiveId: string,
    contractId: string,
    candidates: { specimen_id: string; reuse_mode: string }[],
  ) {
    try {
      const data = await this.withClient((c) =>
        c.callTool<{ status?: string; outcome?: string; reasons?: string[] }>(
          "reusery_resolve",
          {
            primitive_id: primitiveId,
            contract_id: contractId,
            candidates,
          },
        ),
      );
      return {
        ok: true as const,
        status: data.status,
        outcome: data.outcome,
        reasons: data.reasons ?? [],
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }
}

export interface IntegrationRegistry {
  lantern: LanternClient;
  lanternSession(): Promise<LanternSession | null>;
  lanternReason: string;
  reusery: ReuseryClient;
  telltail: TelltailClient;
  tethers: TethersClient;
  describeAll(): IntegrationDescriptor[];
}

export async function createRegistry(
  repoRoot: string,
  env: RegistryEnv = process.env,
): Promise<IntegrationRegistry> {
  // Lantern: bridge binary + reachable service, else explicit degradation.
  const lanternBin = env["PI_QA_LANTERN_BIN"] ?? DEFAULT_LANTERN_BIN;
  const lanternUrl = env["PI_QA_LANTERN_URL"] ?? "http://127.0.0.1:4317";
  let lantern: LanternClient;
  let lanternReason: string;
  let openLantern: (() => Promise<LanternSession | null>) | null = null;

  if (!fileExists(lanternBin)) {
    lanternReason = `NOT_CONFIGURED: bridge binary missing (${lanternBin}); build with cargo build -p lighting`;
    lantern = new LanternClient(null, lanternReason);
  } else if (!(await serveReady(lanternUrl))) {
    lanternReason = `UNREACHABLE: service not ready at ${lanternUrl} (start: cargo run --manifest-path <lantern>/Cargo.toml -p lighting -- serve)`;
    lantern = new LanternClient(null, lanternReason);
  } else {
    lanternReason = `READY: ${lanternBin} → ${lanternUrl}`;
    const openSession = async (): Promise<LanternSession> => {
      const client = new StdioMcpClient({
        command: lanternBin,
        args: ["mcp"],
        env: { LIGHTING_SERVICE_URL: lanternUrl },
      });
      await client.start();
      const caller = mcpCaller(client, "lantern");
      const sessionClient = new LanternClient(caller);
      return { client: sessionClient, close: () => caller.close() };
    };
    openLantern = openSession;
    // Probe once so describe() carries READY with version.
    const probe = await openSession();
    try {
      await probe.client.status();
    } finally {
      await probe.close();
    }
    lantern = probe.client;
  }

  // Reusery: bridge binary + DB URL, else explicit degradation.
  const reuseryBin = env["PI_QA_REUSERY_BIN"] ?? DEFAULT_REUSERY_BIN;
  const dbUrl = env["REUSERY_DATABASE_URL"];
  let reusery: ReuseryClient;
  if (!fileExists(reuseryBin)) {
    reusery = new ReuseryClient(null); // describe(): NOT_CONFIGURED (binary missing)
  } else if (!dbUrl) {
    // Bridge exists but no credential: distinct, actionable diagnosis.
    // The password lives in the environment, never in a file.
    reusery = new ReuseryClient(
      null,
      `bridge present (${reuseryBin}) but REUSERY_DATABASE_URL is not set in this process; export it (see Reusery .env.example) to enable`,
    );
  } else {
    reusery = new ReuseryClient(
      new StdioReuseryMcp(reuseryBin, dbUrl, repoRoot),
    );
  }

  const telltail = new TelltailClient(
    await resolveTelltailCommand({
      repoDir: env["TELLTAIL_REPO"] ?? DEFAULT_TELLTAIL_REPO,
    }),
  );
  const tethers = new TethersClient(await resolveTethersCommand());

  return {
    lantern,
    lanternSession: async () => (openLantern ? openLantern() : null),
    lanternReason,
    reusery,
    telltail,
    tethers,
    describeAll: () => [
      lantern.describe(),
      reusery.describe(),
      telltail.describe(),
      tethers.describe(),
    ],
  };
}
