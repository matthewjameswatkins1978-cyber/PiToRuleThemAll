/**
 * Minimal stdio MCP transport (integration boundary, §31).
 *
 * Design decision (recorded): this speaks spec JSON-RPC over stdio
 * (initialize → tools/list → tools/call, newline-delimited), exactly as
 * Lantern's own prove script and the MCP stdio contract define. It does
 * NOT invent a protocol and does NOT hand-roll MCP framing beyond what
 * the stdio transport is. No SDK dependency: initialize + tools/call is
 * the entire surface QA needs, and the mature alternative
 * (@modelcontextprotocol/sdk) would add a dependency tree to avoid ~90
 * lines. Revisit if QA ever needs sampling, roots, or elicitation.
 *
 * Used by: Lantern bridge (lighting mcp), Reusery bridge (reusery mcp),
 * and any future stdio MCP server. Secrets (DB URLs etc.) travel via
 * process env, never through this file or logs.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface StdioMcpOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class StdioMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioMcpError";
  }
}

export class StdioMcpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private nextId = 1;
  private readonly timeoutMs: number;

  constructor(private readonly opts: StdioMcpOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get started(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const { platformSpawn } = await import("../../evidence/commands.js");
    const { exe, argv } = platformSpawn(this.opts.command, this.opts.args ?? []);
    const proc = spawn(exe, argv, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc = proc;
    proc.stdout?.on("data", (d) => this.onData(String(d)));
    const earlyExit = new Promise<never>((_, reject) => {
      proc.on("error", (e) => reject(new StdioMcpError(`MCP server failed to start: ${(e as Error).message}`)));
      proc.on("exit", (code) => {
        if (this.pending.size > 0) reject(new StdioMcpError(`MCP server exited early (code ${code})`));
      });
    });
    void earlyExit;
    // MCP handshake: initialize, then told about completion.
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-qa", version: "0.1.0" },
    });
    if (init.error) throw new StdioMcpError(`MCP initialize failed: ${JSON.stringify(init.error).slice(0, 300)}`);
    try {
      await this.notify("notifications/initialized", {});
    } catch {
      /* best effort */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // server log line on stdout; ignore
      }
      if (typeof msg["id"] === "number") {
        const cb = this.pending.get(msg["id"]);
        if (cb) {
          this.pending.delete(msg["id"]);
          cb(msg);
        }
      }
      // Server notifications/requests are ignored: QA never serves methods.
    }
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const proc = this.proc;
    if (!proc?.stdin) throw new StdioMcpError("MCP client not started");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StdioMcpError(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new StdioMcpError(`MCP write failed: ${err.message}`));
        }
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const proc = this.proc;
    if (!proc?.stdin) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request("tools/list", {});
    if (res["error"]) throw new StdioMcpError(`tools/list failed: ${JSON.stringify(res["error"]).slice(0, 300)}`);
    const result = res["result"] as { tools?: { name: string; description?: string; inputSchema?: unknown }[] };
    return (result.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  /**
   * Call a tool. Returns the parsed structuredContent when present,
   * else the joined text content. Throws on tool isError.
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res["error"]) throw new StdioMcpError(`tools/call ${name} failed: ${JSON.stringify(res["error"]).slice(0, 300)}`);
    const result = res["result"] as {
      isError?: boolean;
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
    };
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n").slice(0, 500);
      throw new StdioMcpError(`tool ${name} returned isError: ${text}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.buf = "";
    if (!proc) return;
    for (const [, cb] of this.pending) cb({ error: { message: "client stopped" } });
    this.pending.clear();
    proc.stdin?.end();
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, 3000);
      proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    await exited;
  }
}
