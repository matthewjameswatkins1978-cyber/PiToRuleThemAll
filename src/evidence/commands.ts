/**
 * Bounded command execution. Every QA-spawned process goes through here:
 * fixed timeout, fixed output cap, no shell interpolation of arguments,
 * and a compact record suitable for receipts. Never dumps unlimited
 * output; callers keep references (files) instead of pasting streams.
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Max captured chars per stream. Default 32 KiB. */
  maxChars?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 32 * 1024;

function cap(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return {
    text:
      s.slice(0, head) +
      `\n…[${s.length - max} chars truncated]…\n` +
      s.slice(s.length - tail),
    truncated: true,
  };
}

/**
 * Windows runs .cmd shims (npm, npx, pi) that CreateProcess cannot execute
 * directly, so route everything through cmd.exe /d /s /c. Elements stay
 * SEPARATE argv entries: Node applies CreateProcess quoting per element
 * and cmd parses the result normally. (Pre-joining into one string
 * double-quotes and corrupts arguments containing spaces.)
 * Args are QA-generated (commands, flags, paths, patterns) — verify never
 * passes raw builder text as command arguments.
 */
export function platformSpawn(
  cmd: string,
  args: string[],
): { exe: string; argv: string[] } {
  if (process.platform !== "win32") return { exe: cmd, argv: args };
  // A pathed executable (C:\..., .exe) spawns DIRECTLY: CreateProcess
  // quotes spaced image paths correctly. Routing a spaced exe through
  // `cmd /s /c` strips its quotes (observed: 'C:\Program' is not
  // recognized). Bare words (npm, git, sg, ...) have no spaces and go
  // through cmd so PATHEXT resolves .cmd/.bat shims.
  if (/\.exe$/i.test(cmd) || cmd.includes("\\") || cmd.includes("/")) {
    return { exe: cmd, argv: args };
  }
  return { exe: "cmd.exe", argv: ["/d", "/s", "/c", cmd, ...args] };
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const label = [cmd, ...args].join(" ");
  const { exe, argv } = platformSpawn(cmd, args);
  return new Promise((resolve) => {
    execFile(
      exe,
      argv,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
      },
      (error, stdout, stderr) => {
        const out = cap(String(stdout ?? ""), maxChars);
        const err = cap(String(stderr ?? ""), maxChars);
        const timedOut =
          typeof (error as { killed?: boolean; signal?: string } | null)
            ?.signal === "string" &&
          ((error as { signal?: string }).signal === "SIGTERM" ||
            (error as { code?: string | number })?.code === "ETIMEDOUT");
        let exitCode = 0;
        if (error) {
          const code = (error as { code?: unknown }).code;
          exitCode = typeof code === "number" ? code : 1;
        }
        resolve({
          command: label,
          exitCode,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timedOut: Boolean(timedOut),
        });
      },
    );
  });
}

/** True when stdout looks like a refusal/secret leak guard should redact. Fails closed: receipt stores metadata only. */
export function looksLikeSecret(s: string): boolean {
  return /(sk-[A-Za-z0-9]|gh[pousr]_|xox[bpas]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/.test(
    s,
  );
}
