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
function collectTags(row, columns) {
    const all = [];
    for (const col of columns) {
        all.push(...parseTags(row[col]));
    }
    return [...new Set(all)];
}
function getGeo(row) {
    const parts = [row["city"], row["province"], row["ip_location"]]
        .filter((v) => typeof v === "string" && v.length > 0);
    return parts.join(" ");
}
export function mysqlConfigFromEnv() {
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
export async function fetchCreatorRows(config, _sourceMapping, maxRows) {
    let mysql2;
    try {
        mysql2 = await import("mysql2/promise");
    }
    catch {
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
    const allRows = [];
    try {
        const xhsTagCols = [
            "pugongying_category",
            "grow_category",
            "persona_tags",
            "content_feature_tags",
            "tone_tags",
            "other_tags",
        ];
        const xhsCols = [
            "xhs_account_id",
            "account_nickname",
            "city",
            "province",
            "ip_location",
            "profile_url",
            "data_updated_at",
            ...xhsTagCols,
        ];
        const [xhsRows] = await conn.query(`SELECT ${xhsCols.join(", ")} FROM xhs_creator_accounts WHERE data_updated_at IS NOT NULL${limitClause}`);
        if (Array.isArray(xhsRows)) {
            for (const r of xhsRows) {
                const tags = collectTags(r, xhsTagCols);
                if (tags.length === 0)
                    continue;
                const geo = getGeo(r);
                if (geo)
                    tags.push(geo);
                allRows.push({
                    platform: "xhs",
                    platform_account_id: String(r["xhs_account_id"] ?? ""),
                    source_table: "xhs_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r["data_updated_at"] ?? ""),
                    display_name: r["account_nickname"] ? String(r["account_nickname"]) : undefined,
                    profile_url: r["profile_url"] ? String(r["profile_url"]) : undefined,
                });
            }
        }
        const dyTagCols = [
            "xingtu_creator_type",
            "grow_creator_type",
            "content_topic_tags",
            "industry_tags",
        ];
        const dyCols = [
            "dy_account_id",
            "account_nickname",
            "city",
            "province",
            "ip_location",
            "profile_url",
            "data_updated_at",
            ...dyTagCols,
        ];
        const [dyRows] = await conn.query(`SELECT ${dyCols.join(", ")} FROM dy_creator_accounts WHERE data_updated_at IS NOT NULL${limitClause}`);
        if (Array.isArray(dyRows)) {
            for (const r of dyRows) {
                const tags = collectTags(r, dyTagCols);
                if (tags.length === 0)
                    continue;
                const geo = getGeo(r);
                if (geo)
                    tags.push(geo);
                allRows.push({
                    platform: "dy",
                    platform_account_id: String(r["dy_account_id"] ?? ""),
                    source_table: "dy_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r["data_updated_at"] ?? ""),
                    display_name: r["account_nickname"] ? String(r["account_nickname"]) : undefined,
                    profile_url: r["profile_url"] ? String(r["profile_url"]) : undefined,
                });
            }
        }
    }
    finally {
        await conn.end();
    }
    return allRows;
}
