/**
 * Minimal JSON-RPC-over-stdio MCP server.
 *
 * Reads newline-delimited JSON from stdin, writes responses to stdout.
 * Logs ONLY to stderr — stdout is the MCP transport.
 */
import { createInterface } from "node:readline";
import { handleToolCall } from "./tools/handlers.js";
import { TOOL_DEFINITIONS } from "./tools/listTools.js";
// ── Stdout writer ───────────────────────────────────────────────────
function sendResponse(response) {
    process.stdout.write(JSON.stringify(response) + "\n");
}
function sendResult(id, result) {
    sendResponse({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
    sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code, message },
    });
}
// ── Request handler ─────────────────────────────────────────────────
async function handleRequest(request) {
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
            const { name, arguments: args } = (params ?? {});
            if (!name) {
                sendError(id, -32602, "Missing tool name in params");
                return;
            }
            const result = await handleToolCall(name, args ?? {});
            sendResult(id, result);
            break;
        }
        default:
            sendError(id, -32601, `Method not found: ${method}`);
    }
}
// ── Stdio transport ─────────────────────────────────────────────────
function log(msg) {
    process.stderr.write(`[vector-mcp] ${msg}\n`);
}
function startServer() {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            return;
        let request;
        try {
            request = JSON.parse(trimmed);
        }
        catch {
            sendError(null, -32700, "Parse error");
            return;
        }
        if (!request.method || request.id === undefined) {
            sendError(null, -32600, "Invalid request: missing method or id");
            return;
        }
        handleRequest(request).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            sendError(request.id, -32603, `Internal error: ${message}`);
        });
    });
    rl.on("close", () => {
        log("stdin closed, exiting");
        process.exit(0);
    });
    log("server started on stdio");
}
startServer();
