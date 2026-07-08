/**
 * Tool call handlers for the vector MCP server.
 *
 * Supports two modes via VECTOR_MCP_MODE env var:
 * - "fake" (default): deterministic fake embeddings + in-memory Qdrant
 * - "real": SiliconFlow embedding/reranker + MySQL data source
 */
import type { McpToolResult } from "../mcp-protocol.js";
export declare function handleToolCall(name: string, params: unknown): Promise<McpToolResult>;
