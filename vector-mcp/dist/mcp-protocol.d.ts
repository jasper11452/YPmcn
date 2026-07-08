/**
 * Minimal JSON-RPC 2.0 and MCP type definitions.
 *
 * No zod — plain TypeScript interfaces.
 */
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params?: unknown;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: JsonRpcError;
}
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface McpToolCallParams {
    name: string;
    arguments?: Record<string, unknown>;
}
export interface McpToolResult {
    success: boolean;
    data?: unknown;
    error?: {
        code: string;
        message: string;
    };
    trace_id: string;
}
export interface McpInitializeResult {
    protocolVersion: "2024-11-05";
    serverInfo: {
        name: string;
        version: string;
    };
    capabilities: {
        tools: Record<string, never>;
    };
}
export interface McpListToolsResult {
    tools: readonly McpToolDefinition[];
}
