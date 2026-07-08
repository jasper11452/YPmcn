// @ts-nocheck
import { createInterface } from "node:readline";
import { handleToolCall } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/listTools.js";

function sendResponse(response: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function sendResult(id: string | number | null, result: unknown): void {
  sendResponse({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number | null, code: number, message: string): void {
  sendResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(request: { id: string | number | null; method: string; params?: unknown }): Promise<void> {
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "vector-mcp", version: "0.1.0" },
        capabilities: { tools: {} },
      });
      break;
    case "tools/list":
      sendResult(id, { tools: TOOL_DEFINITIONS });
      break;
    case "tools/call": {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = p?.name;
      if (!toolName) { sendError(id, -32602, "Missing tool name in params"); return; }
      const result = await handleToolCall(toolName, p?.arguments ?? {});
      sendResult(id, result);
      break;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function startServer(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let request: { method?: string; id?: string | number; params?: unknown } | undefined;
    try { request = JSON.parse(trimmed); } catch { sendError(null, -32700, "Parse error"); return; }
    if (!request?.method || request.id === undefined) { sendError(null, -32600, "Invalid request"); return; }
    handleRequest(request as { id: string | number; method: string; params?: unknown }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      sendError(request!.id!, -32603, `Internal error: ${message}`);
    });
  });
  rl.on("close", () => {
    process.stderr.write("[vector-mcp] stdin closed, exiting\n");
    process.exit(0);
  });
  process.stderr.write("[vector-mcp] server started on stdio\n");
}

startServer();
