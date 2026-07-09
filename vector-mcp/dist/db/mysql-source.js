function parseTags(value) {
    if (value === null || value === undefined)
        return [];
    if (Array.isArray(value))
        return value.filter((v) => typeof v === "string");
    if (typeof value === "string") {
        if (value.trim().length === 0)
            return [];
        try {
            const p = JSON.parse(value);
            if (Array.isArray(p))
                return p.filter((v) => typeof v === "string");
        }
        catch {
            // not JSON — treat as delimiter-separated string
        }
        return value.split(/[、,，\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
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
    const parts = [row["kw_city"], row["kw_province"], row["kw_ip_dependency"]]
        .filter((v) => typeof v === "string" && v.length > 0);
    return parts.join(" ");
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
        const [xhsRows] = await conn.query(`SELECT ${xhsCols.join(", ")} FROM xhs_creator_accounts WHERE date IS NOT NULL${limitClause}`);
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
                    platform_account_id: String(r["id"] ?? ""),
                    source_table: "xhs_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r["date"] ?? ""),
                    display_name: r["nickname"] ? String(r["nickname"]) : undefined,
                    profile_url: r["kw_user_url"] ? String(r["kw_user_url"]) : undefined,
                });
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
        const [dyRows] = await conn.query(`SELECT ${dyCols.join(", ")} FROM dy_creator_accounts WHERE date IS NOT NULL${limitClause}`);
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
                    platform_account_id: String(r["id"] ?? ""),
                    source_table: "dy_creator_accounts",
                    content_tags: tags,
                    grow_tags: [],
                    source_updated_at: String(r["date"] ?? ""),
                    display_name: r["nickname"] ? String(r["nickname"]) : undefined,
                    profile_url: r["kw_user_url"] ? String(r["kw_user_url"]) : undefined,
                });
            }
        }
    }
    finally {
        await conn.end();
    }
    return allRows;
}
