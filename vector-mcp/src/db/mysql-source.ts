export type CreatorPlatform = "dy" | "xhs";

export interface MysqlSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectionLimit?: number;
  dyTable: string;
  xhsTable?: string;
  projectTable: string;
  allowedTables: string[];
}

export interface CreatorRow {
  platform: CreatorPlatform;
  kwUid: string;
  sourceTable: string;
  sourceRowId: string;
  sourceSnapshotDate: string;
  sourceUpdatedAt: string;
  itemId?: string;
  douyinId?: string;
  description?: string;
  profile?: string;
  province?: string;
  city?: string;
  followerCount?: number;
  dataJson?: unknown;
}

export interface SourceReadResult {
  status: "available" | "unavailable";
  platform: CreatorPlatform;
  rows: CreatorRow[];
  reason?: "source_not_configured" | "source_table_missing";
  cursor?: string;
}

export interface SqlExecutor {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown?]>;
  end?(): Promise<void>;
}

const COMMON_CREATOR_COLUMNS = [
  "kwUid",
  "update_time",
  "date",
  "description",
  "kwProvince AS province",
  "kwCity AS city",
  "followercount AS follower_count",
] as const;
const CREATOR_COLUMNS: Record<CreatorPlatform, readonly string[]> = {
  dy: [
    ...COMMON_CREATOR_COLUMNS,
    "douyinId",
    "verifiedreason",
    "tagBrand",
    "contentThemeLabel",
    "industryTagLabel",
    "xtTalentTypeLabel",
    "growTalentTypeLabel",
    "talentTypeLabel",
  ],
  xhs: [
    ...COMMON_CREATOR_COLUMNS,
    "xiaohongshuId",
    "verifiedreason",
    "tagBrand",
    "kolPersonaLabel",
    "contentFeatureLabel",
    "talentTypeLabel",
    "pgyBloggerTypeLabel",
    "growBloggerTypeLabel",
    "contentTag",
    "businessIndustry",
  ],
};
const SEMANTIC_FIELDS: Record<CreatorPlatform, readonly string[]> = {
  dy: [
    "description",
    "verifiedreason",
    "tagBrand",
    "contentThemeLabel",
    "industryTagLabel",
    "xtTalentTypeLabel",
    "growTalentTypeLabel",
    "talentTypeLabel",
  ],
  xhs: [
    "description",
    "verifiedreason",
    "tagBrand",
    "kolPersonaLabel",
    "contentFeatureLabel",
    "talentTypeLabel",
    "pgyBloggerTypeLabel",
    "growBloggerTypeLabel",
    "contentTag",
    "businessIndustry",
  ],
};
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envValue(env: NodeJS.ProcessEnv, yp: string, legacy: string, fallback = ""): string {
  return env[yp] ?? env[legacy] ?? fallback;
}

export function mysqlSourceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MysqlSourceConfig {
  const dyTable = env.VECTOR_DY_SOURCE_TABLE ?? "dy_mz";
  const xhsTable = env.VECTOR_XHS_SOURCE_TABLE?.trim() || "xhs_mz";
  const projectTable = env.VECTOR_PROJECT_SOURCE_TABLE ?? "core_project";
  const configured = (env.VECTOR_SOURCE_TABLE_ALLOWLIST ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return {
    host: envValue(env, "YP_MYSQL_HOST", "MYSQL_HOST", "localhost"),
    port: Number(envValue(env, "YP_MYSQL_PORT", "MYSQL_PORT", "3306")) || 3306,
    user: envValue(env, "YP_MYSQL_USER", "MYSQL_USER", "root"),
    password: envValue(env, "YP_MYSQL_PASSWORD", "MYSQL_PASSWORD"),
    database: envValue(env, "YP_MYSQL_DATABASE", "MYSQL_DATABASE", "test"),
    ssl: envValue(env, "YP_MYSQL_SSL", "MYSQL_SSL") === "true",
    connectionLimit: Number(env.VECTOR_MYSQL_CONNECTION_LIMIT) || 4,
    dyTable,
    xhsTable,
    projectTable,
    allowedTables: [...new Set(["dy_mz", "xhs_mz", "core_project", dyTable, projectTable, xhsTable, ...configured])],
  };
}

export function validateTableIdentifier(table: string, allowlist: string[]): string {
  if (!IDENTIFIER.test(table) || !allowlist.includes(table)) {
    throw new TypeError("Source table is not in the configured allowlist");
  }
  return table;
}

function isMissingTable(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number };
  return candidate?.code === "ER_NO_SUCH_TABLE" || candidate?.errno === 1146;
}

function stringValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown): number | undefined {
  const resolved = typeof value === "number" ? value : Number(value);
  return Number.isFinite(resolved) ? resolved : undefined;
}

function semanticData(platform: CreatorPlatform, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    SEMANTIC_FIELDS[platform]
      .filter((field) => row[field] !== null && row[field] !== undefined && row[field] !== "")
      .map((field) => [field, row[field]]),
  );
}

function mapRow(platform: CreatorPlatform, sourceTable: string, row: Record<string, unknown>): CreatorRow | null {
  const kwUid = stringValue(row.kwUid).trim();
  const sourceUpdatedAt = stringValue(row.update_time).trim();
  const sourceSnapshotDate = stringValue(row.date).trim() || sourceUpdatedAt.slice(0, 10);
  if (!kwUid || !sourceUpdatedAt || !sourceSnapshotDate) return null;
  return {
    platform,
    kwUid,
    sourceTable,
    sourceRowId: kwUid,
    sourceSnapshotDate,
    sourceUpdatedAt,
    douyinId: stringValue(row.douyinId) || undefined,
    description: stringValue(row.description) || undefined,
    province: stringValue(row.province) || undefined,
    city: stringValue(row.city) || undefined,
    followerCount: numberValue(row.follower_count),
    dataJson: semanticData(platform, row),
  };
}

export class MysqlReadonlySource {
  constructor(private readonly config: MysqlSourceConfig, private readonly sql: SqlExecutor) {}

  private tableFor(platform: CreatorPlatform): string | undefined {
    return platform === "dy" ? this.config.dyTable : this.config.xhsTable;
  }

  async readCreators(platform: CreatorPlatform, options: { cursor?: string; limit?: number } = {}): Promise<SourceReadResult> {
    const configuredTable = this.tableFor(platform);
    if (!configuredTable) return { status: "unavailable", platform, rows: [], reason: "source_not_configured" };
    const table = validateTableIdentifier(configuredTable, this.config.allowedTables);
    const limit = options.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 10_000)) throw new TypeError("limit must be between 1 and 10000");
    const cursorClause = options.cursor ? " WHERE update_time > ?" : "";
    const limitClause = limit === undefined ? "" : " LIMIT ?";
    const values: unknown[] = [...(options.cursor ? [options.cursor] : []), ...(limit === undefined ? [] : [limit])];
    const sql = `SELECT ${CREATOR_COLUMNS[platform].join(", ")} FROM \`${table}\`${cursorClause} ORDER BY update_time ASC, kwUid ASC${limitClause}`;
    try {
      const [rawRows] = await this.sql.query(sql, values);
      const rows = (Array.isArray(rawRows) ? rawRows : [])
        .map((row) => mapRow(platform, table, row as Record<string, unknown>))
        .filter((row): row is CreatorRow => row !== null);
      return {
        status: "available",
        platform,
        rows,
        cursor: rows.length > 0 ? rows[rows.length - 1].sourceUpdatedAt : options.cursor,
      };
    } catch (error) {
      if (isMissingTable(error)) return { status: "unavailable", platform, rows: [], reason: "source_table_missing" };
      throw error;
    }
  }

  async rehydrate(platform: CreatorPlatform, kwUids: string[]): Promise<CreatorRow[]> {
    if (kwUids.length === 0) return [];
    const configuredTable = this.tableFor(platform);
    if (!configuredTable) return [];
    const table = validateTableIdentifier(configuredTable, this.config.allowedTables);
    const identities = [...new Set(kwUids)].sort();
    if (identities.length > 1000) throw new TypeError("rehydrate identity limit exceeded");
    const placeholders = identities.map(() => "?").join(", ");
    const sql = `SELECT ${CREATOR_COLUMNS[platform].join(", ")} FROM \`${table}\` WHERE kwUid IN (${placeholders}) ORDER BY kwUid ASC, update_time DESC`;
    try {
      const [rawRows] = await this.sql.query(sql, identities);
      const latest = new Map<string, CreatorRow>();
      for (const raw of Array.isArray(rawRows) ? rawRows : []) {
        const row = mapRow(platform, table, raw as Record<string, unknown>);
        if (row && !latest.has(row.kwUid)) latest.set(row.kwUid, row);
      }
      return identities.flatMap((id) => latest.get(id) ? [latest.get(id)!] : []);
    } catch (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
  }

  async loadProjectDescription(projectId: string | number): Promise<string | null> {
    const table = validateTableIdentifier(this.config.projectTable, this.config.allowedTables);
    const [rows] = await this.sql.query(
      `SELECT description FROM \`${table}\` WHERE id = ? LIMIT 1`,
      [projectId],
    );
    const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    return first && typeof first.description === "string" ? first.description : null;
  }
}

export async function createMysqlReadonlySource(config: MysqlSourceConfig): Promise<{ source: MysqlReadonlySource; close: () => Promise<void> }> {
  const mysql2 = await import("mysql2/promise");
  const pool = mysql2.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    connectionLimit: config.connectionLimit,
    dateStrings: true,
  });
  return { source: new MysqlReadonlySource(config, pool as unknown as SqlExecutor), close: () => pool.end() };
}
