import type { CreatorSourceRow } from "../vector/sync.js";
import type { SourceMappings, SourcePlatform } from "../source/contract.js";

export interface MysqlSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectionLimit?: number;
}

function parseTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    if (value.trim().length === 0) return [];
    try {
      const p = JSON.parse(value);
      if (Array.isArray(p)) return p.filter((v): v is string => typeof v === "string");
    } catch {
      // not JSON — treat as delimiter-separated string
    }
    return value.split(/[、,，\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function collectTags(row: Record<string, unknown>, columns: string[]): string[] {
  const all: string[] = [];
  for (const col of columns) {
    all.push(...parseTags(row[col]));
  }
  return [...new Set(all)];
}

function getGeo(row: Record<string, unknown>): string {
  const parts = [row["kw_city"], row["kw_province"], row["kw_ip_dependency"]]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.join(" ");
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

export async function fetchCreatorRows(
  config: MysqlSourceConfig,
  _sourceMapping: SourceMappings,
  maxRows?: number
): Promise<CreatorSourceRow[]> {
  let mysql2: typeof import("mysql2/promise");
  try {
    mysql2 = await import("mysql2/promise");
  } catch {
    throw new Error("mysql2 required: npm install mysql2");
  }

  const conn = await mysql2.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });

  const limitClause = maxRows && maxRows > 0 ? ` LIMIT ${maxRows}` : "";
  const allRows: CreatorSourceRow[] = [];

  try {
    const xhsTagCols = [
      "content_type_label",
      "content_theme_label",
      "industry_tag_label",
      "xt_talent_type_label",
      "grow_talent_type_label",
      "talent_type_label",
    ];
    const xhsCols = [
      "id",
      "nickname",
      "kw_city",
      "kw_province",
      "kw_ip_dependency",
      "kw_user_url",
      "date",
      ...xhsTagCols,
    ];
    const [xhsRows] = await conn.query(
      `SELECT ${xhsCols.join(", ")} FROM xhs_creator_accounts WHERE date IS NOT NULL${limitClause}`
    );
    if (Array.isArray(xhsRows)) {
      for (const r of xhsRows as Record<string, unknown>[]) {
        const tags = collectTags(r, xhsTagCols);
        if (tags.length === 0) continue;
        const geo = getGeo(r);
        if (geo) tags.push(geo);
        allRows.push({
          platform: "xhs",
          platform_account_id: String(r["id"] ?? ""),
          source_table: "xhs_creator_accounts",
          content_tags: tags,
          grow_tags: [],
          source_updated_at: String(r["date"] ?? ""),
          display_name: r["nickname"] ? String(r["nickname"]) : undefined,
          profile_url: r["kw_user_url"] ? String(r["kw_user_url"]) : undefined,
        } as CreatorSourceRow);
      }
    }

    const dyTagCols = [
      "content_type_label",
      "kol_persona_label",
      "content_feature_label",
      "content_tag",
      "business_industry",
      "pgy_blogger_type_label",
      "grow_blogger_type_label",
      "talent_type_label",
    ];
    const dyCols = [
      "id",
      "nickname",
      "kw_city",
      "kw_province",
      "kw_ip_dependency",
      "kw_user_url",
      "date",
      ...dyTagCols,
    ];
    const [dyRows] = await conn.query(
      `SELECT ${dyCols.join(", ")} FROM dy_creator_accounts WHERE date IS NOT NULL${limitClause}`
    );
    if (Array.isArray(dyRows)) {
      for (const r of dyRows as Record<string, unknown>[]) {
        const tags = collectTags(r, dyTagCols);
        if (tags.length === 0) continue;
        const geo = getGeo(r);
        if (geo) tags.push(geo);
        allRows.push({
          platform: "dy",
          platform_account_id: String(r["id"] ?? ""),
          source_table: "dy_creator_accounts",
          content_tags: tags,
          grow_tags: [],
          source_updated_at: String(r["date"] ?? ""),
          display_name: r["nickname"] ? String(r["nickname"]) : undefined,
          profile_url: r["kw_user_url"] ? String(r["kw_user_url"]) : undefined,
        } as CreatorSourceRow);
      }
    }
  } finally {
    await conn.end();
  }

  return allRows;
}
