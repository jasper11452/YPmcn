// @ts-nocheck
import type { CreatorSourceRow } from "../vector/sync.js";

export interface MysqlSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectionLimit?: number;
}

export function mysqlConfigFromEnv(): MysqlSourceConfig {
  return {
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "test",
  };
}

export async function fetchCreatorRows(
  _config: MysqlSourceConfig,
  _sourceMapping: Record<string, Record<string, string>>,
  _maxRows?: number
): Promise<CreatorSourceRow[]> {
  return [];
}
