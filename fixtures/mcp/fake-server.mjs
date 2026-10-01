#!/usr/bin/env node
// Fake stdio MCP server for transport unit tests. Speaks initialize,
// tools/list, tools/call over newline-delimited JSON-RPC. Tools:
//   echo   → returns structuredContent {echo: <args>}
//   boom   → returns isError result
//   silent → never responds (timeout testing)
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(id, result, error) {
  const msg = { jsonrpc: "2.0", id };
  if (error !== undefined) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.method === "initialize") {
    send(req.id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake", version: "0" },
    });
  } else if (req.method === "notifications/initialized") {
    // no-op
  } else if (req.method === "tools/list") {
    send(req.id, {
      tools: [
        { name: "echo", description: "echo", inputSchema: { type: "object" } },
        { name: "boom", description: "fails", inputSchema: { type: "object" } },
      ],
    });
  } else if (req.method === "tools/call") {
    const name = req.params?.name;
    if (name === "echo") {
      send(req.id, {
        content: [{ type: "text", text: "echo" }],
        structuredContent: { echo: req.params?.arguments ?? {} },
      });
    } else if (name === "boom") {
      send(req.id, {
        content: [{ type: "text", text: "kaput" }],
        isError: true,
      });
    } else if (name === "silent") {
      // never respond
    } else {
      send(req.id, undefined, {
        code: -32602,
        message: `unknown tool ${name}`,
      });
    }
  } else {
    send(req.id, undefined, {
      code: -32601,
      message: `unknown method ${req.method}`,
    });
  }
});
