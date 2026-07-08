/**
 * Config error codes map to the YPmcn response envelope { success, data, error, trace_id }.
 * Callers can forward `code` directly into the `error` field.
 */
export type ConfigErrorCode = "BAILIAN_CONFIG_MISSING" | "MYSQL_CONFIG_MISSING" | "QDRANT_CONFIG_MISSING";
export declare class ConfigError extends Error {
    readonly code: ConfigErrorCode;
    readonly missingVars: string[];
    constructor(code: ConfigErrorCode, missingVars: string[]);
}
