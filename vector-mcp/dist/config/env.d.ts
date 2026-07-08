import type { VectorMcpConfig } from "./types.js";
export declare function loadConfigFromEnv(env?: NodeJS.ProcessEnv): VectorMcpConfig;
/**
 * Redact secrets for safe logging. Replaces password/apiKey with "***".
 */
export declare function redactConfig(cfg: VectorMcpConfig): VectorMcpConfig;
