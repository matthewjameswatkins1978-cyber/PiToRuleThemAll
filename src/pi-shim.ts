/**
 * Minimal structural Pi API surface used by this extension.
 *
 * Adapter-boundary decision (§33): the core never imports Pi types, and
 * this shim declares only the members QA touches. At Pi runtime the real
 * ExtensionAPI satisfies it structurally; at build/test time no Pi
 * package is required. A Pi upgrade can break at most this file.
 */

export interface PiUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface PiToolInfo {
  name: string;
  description?: string;
}

export interface PiCommandContext {
  cwd: string;
  ui: PiUi;
}

export interface PiToolCallContext extends PiCommandContext {
  tools: { name: string }[];
  executeTool(
    name: string,
    args: unknown,
  ): Promise<{
    result: { content: { type?: string; text?: string }[] };
    isError: boolean;
  }>;
}

export interface PiApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: PiToolCallContext,
    ) => Promise<{
      content: { type: string; text: string }[];
      details?: unknown;
      isError?: boolean;
    }>;
  }): void;
  getAllTools(): PiToolInfo[];
}
