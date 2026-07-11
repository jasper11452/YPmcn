#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { createReferenceState, createToolDefinitions } from "./state.mjs";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleJsonRpc(message, state) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(message?.id, -32600, "Invalid JSON-RPC request");
  }
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "initialize") {
    return rpcResult(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ypmcn-reference-mcp", version: "3.0.0" },
      instructions: "Network-free simulation only. Never treat results as production evidence.",
    });
  }
  if (message.method === "tools/list") {
    return rpcResult(message.id, { tools: createToolDefinitions() });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (typeof name !== "string") return rpcError(message.id, -32602, "Tool name is required");
    const call = await state.callTool(name, args);
    return rpcResult(message.id, {
      content: [{ type: "text", text: JSON.stringify(call.output) }],
      structuredContent: call.output,
      isError: call.output?.success === false,
      _meta: { simulated: true, productionEvidence: false },
    });
  }
  if (message.id === undefined) return undefined;
  return rpcError(message.id, -32601, `Method ${String(message.method)} not found`);
}

export function runStdioServer(options = {}) {
  const state = options.state ?? createReferenceState();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity });

  lines.on("line", async (line) => {
    if (line.trim().length === 0) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, "Parse error"))}\n`);
      return;
    }
    try {
      const response = await handleJsonRpc(message, state);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const response = rpcError(message.id, -32603, error instanceof Error ? error.message : String(error));
      output.write(`${JSON.stringify(response)}\n`);
    }
  });
  return { lines, state };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) runStdioServer();

