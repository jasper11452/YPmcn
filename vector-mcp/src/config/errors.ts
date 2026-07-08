// @ts-nocheck
export type ConfigErrorCode = "BAILIAN_CONFIG_MISSING" | "MYSQL_CONFIG_MISSING" | "QDRANT_CONFIG_MISSING";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly missingVars: string[];
  constructor(code: ConfigErrorCode, missingVars: string[]) {
    super(`Config error: ${code} — missing: ${missingVars.join(", ")}`);
    this.code = code;
    this.missingVars = missingVars;
  }
}
