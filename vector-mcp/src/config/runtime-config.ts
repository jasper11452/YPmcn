// @ts-nocheck
/**
 * Centralized runtime settings reader.
 *
 * Keep runtime settings isolated from provider, database, and transport modules.
 */

// ── Mode ──────────────────────────────────────────────────────────────────────
export const MODE: "real" | "fake" =
  process.env.VECTOR_MCP_MODE === "real" ? "real" : "fake";

// ── Persist paths ─────────────────────────────────────────────────────────────
export const FAKE_PERSIST_PATH: string =
  process.env.VECTOR_PERSIST_PATH ??
  new URL("../../.qdrant-fake.json", import.meta.url).pathname;

export const REAL_PERSIST_PATH: string =
  process.env.VECTOR_PERSIST_PATH ??
  new URL("../../.qdrant-real.json", import.meta.url).pathname;

// ── SiliconFlow ───────────────────────────────────────────────────────────────
function getApiKeyOrThrow(): string {
  const key = process.env.SILICONFLOW_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error(
      "SILICONFLOW_API_KEY env var is required for real mode. Set it to your SiliconFlow API key.",
    );
  }
  return key;
}

export const SILICONFLOW_API_KEY: string | null =
  process.env.SILICONFLOW_API_KEY && process.env.SILICONFLOW_API_KEY.trim() !== ""
    ? process.env.SILICONFLOW_API_KEY
    : null;

export function requireSiliconFlowApiKey(): string {
  return getApiKeyOrThrow();
}

// ── Resync ────────────────────────────────────────────────────────────────────
export const FORCE_RESYNC: boolean = process.env.VECTOR_FORCE_RESYNC === "true";

// ── Source mapping ────────────────────────────────────────────────────────────
export const SOURCE_MAPPING_PATH: string =
  process.env.SOURCE_MAPPING_PATH ??
  new URL("../../source/mapping.example.json", import.meta.url).pathname;

// ── MySQL ─────────────────────────────────────────────────────────────────────
export interface MysqlSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  connectionLimit?: number;
}

export function mysqlConfigFromEnv(): MysqlSourceConfig {
  return {
    host: process.env["MYSQL_HOST"] ?? "localhost",
    port: Number(process.env["MYSQL_PORT"]) || 3306,
    user: process.env["MYSQL_USER"] ?? "root",
    password: process.env["MYSQL_PASSWORD"] ?? "",
    database: process.env["MYSQL_DATABASE"] ?? "test",
    ssl: process.env["MYSQL_SSL"] === "true",
    connectionLimit: process.env["MYSQL_CONNECTION_LIMIT"]
      ? Number(process.env["MYSQL_CONNECTION_LIMIT"])
      : undefined,
  };
}

export const MYSQL_FETCH_LIMIT: number | undefined = ((): number | undefined => {
  const limit = process.env["MYSQL_FETCH_LIMIT"];
  return limit && limit.trim() !== "" ? Number(limit) : undefined;
})();

// ── Health-check helpers ──────────────────────────────────────────────────────
export const HAS_SILICONFLOW_API_KEY: boolean = !!process.env.SILICONFLOW_API_KEY;
export const HAS_MYSQL_CONFIG: boolean =
  !!process.env.MYSQL_HOST && !!process.env.MYSQL_USER;
