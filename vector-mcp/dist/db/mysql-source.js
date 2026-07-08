/**
 * MySQL real data source for creator rows.
 *
 * Connects to MySQL and fetches creator data from 小红书达人表 and 抖音达人表.
 * Requires mysql2 package: npm install mysql2
 *
 * Real table names: xhs_creator_accounts, dy_creator_accounts
 *
 * xhs 向量化字段: pugongying_category, grow_category, persona_tags, content_feature_tags, tone_tags, other_tags
 * dy  向量化字段: xingtu_creator_type, grow_creator_type, content_topic_tags, industry_tags
 *
 * 所有 JSON 标签数组合并为 content_tags，grow_tags 留空占位。
 */
/** Parse a JSON column value (may be string or already parsed array) */
function parseTags(value) {
    if (value === null || value === undefined)
        return [];
    if (Array.isArray(value))
        return value.filter((v) => typeof v === "string");
    if (typeof value === "string") {
        try {
            const p = JSON.parse(value);
            return Array.isArray(p) ? p.filter((v) => typeof v === "string") : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
/** Fetch all tag values from multiple columns and merge into flat deduplicated list */
function collectTags(row, columns) {
    const all = [];
    for (const col of columns) {
        all.push(...parseTags(row[col]));
    }
    return [...new Set(all)];
}
export async function fetchCreatorRows(config, _sourceMapping, maxRows) {
    const limitClause = maxRows && maxRows > 0 ? ` LIMIT ${maxRows}` : "";
    let mysql2;
    try {
        mysql2 = await import("mysql2/promise");
    }
    catch {
        throw new Error("mysql2 required: npm install mysql2");
    }
    const conn = await mysql2.createConnection({
        host: config.host, port: config.port,
        user: config.user, password: config.password,
        database: config.database,
    });
    const allRows = [];
    try {
        // xhs: 6 tag columns
        const xhsTagCols = ["pugongying_category", "grow_category", "persona_tags", "content_feature_tags", "tone_tags", "other_tags"];
        const xhsCols = ["xhs_account_id", "account_nickname", "city", "province", "ip_location", "profile_url", "data_updated_at", ...xhsTagCols];
        const [xhsRows] = await conn.query(`SELECT ${xhsCols.join(", ")} FROM xhs_creator_accounts WHERE data_updated_at IS NOT NULL${limitClause}`);
        if (Array.isArray(xhsRows)) {
            for (const r of xhsRows) {
                const tags = collectTags(r, xhsTagCols);
                if (tags.length === 0)
                    continue;
                const geo = [r.city, r.province, r.ip_location].filter(v => typeof v === "string" && v.length > 0).join(" ");
                allRows.push({
                    platform: "xhs",
                    platform_account_id: String(r.xhs_account_id ?? ""),
                    source_table: "xhs_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r.data_updated_at ?? ""),
                    display_name: r.account_nickname ? String(r.account_nickname) : undefined,
                    profile_url: r.profile_url ? String(r.profile_url) : undefined,
                });
            }
        }
        // dy: 4 tag columns
        const dyTagCols = ["xingtu_creator_type", "grow_creator_type", "content_topic_tags", "industry_tags"];
        const dyCols = ["dy_account_id", "account_nickname", "city", "province", "ip_location", "profile_url", "data_updated_at", ...dyTagCols];
        const [dyRows] = await conn.query(`SELECT ${dyCols.join(", ")} FROM dy_creator_accounts WHERE data_updated_at IS NOT NULL${limitClause}`);
        if (Array.isArray(dyRows)) {
            for (const r of dyRows) {
                const tags = collectTags(r, dyTagCols);
                if (tags.length === 0)
                    continue;
                const geo = [r.city, r.province, r.ip_location].filter(v => typeof v === "string" && v.length > 0).join(" ");
                allRows.push({
                    platform: "dy",
                    platform_account_id: String(r.dy_account_id ?? ""),
                    source_table: "dy_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r.data_updated_at ?? ""),
                    display_name: r.account_nickname ? String(r.account_nickname) : undefined,
                    profile_url: r.profile_url ? String(r.profile_url) : undefined,
                });
            }
        }
    }
    finally {
        await conn.end();
    }
    return allRows;
}
export function mysqlConfigFromEnv() {
    return {
        host: process.env.MYSQL_HOST ?? "127.0.0.1",
        port: Number(process.env.MYSQL_PORT ?? 3306),
        user: process.env.MYSQL_USER ?? "",
        password: process.env.MYSQL_PASSWORD ?? "",
        database: process.env.MYSQL_DATABASE ?? "",
    };
}
