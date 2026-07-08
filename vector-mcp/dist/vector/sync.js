function extractTags(raw) {
    if (raw === null || raw === undefined)
        return [];
    if (Array.isArray(raw))
        return raw.filter((t) => typeof t === "string");
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed.filter((t) => typeof t === "string");
        }
        catch {
            return raw.trim().length > 0 ? [raw] : [];
        }
    }
    return [];
}
function normalizeText(tags) {
    return [...tags].sort().join("|");
}
function buildPointId(platform, platformAccountId, tagType, vectorVersion) {
    return `${platform}:${platformAccountId}:${tagType}:${vectorVersion}`;
}
export async function buildVectorPoints(rows, embeddingProvider, vectorVersion) {
    const items = [];
    for (const row of rows) {
        const contentTags = extractTags(row.content_tags);
        const growTags = extractTags(row.grow_tags);
        if (contentTags.length > 0) {
            items.push({ text: normalizeText(contentTags), row, tagType: "content", tags: contentTags });
        }
        if (growTags.length > 0) {
            items.push({ text: normalizeText(growTags), row, tagType: "grow", tags: growTags });
        }
    }
    if (items.length === 0)
        return [];
    const texts = items.map((item) => item.text);
    const vectors = await embeddingProvider.embed(texts);
    const modelId = embeddingProvider.modelId();
    return items.map((item, idx) => {
        const id = buildPointId(item.row.platform, item.row.platform_account_id, item.tagType, vectorVersion);
        const payload = {
            platform: item.row.platform,
            platform_account_id: item.row.platform_account_id,
            source_table: item.row.source_table,
            tag_type: item.tagType,
            raw_tags: item.tags,
            normalized_text: item.text,
            source_updated_at: item.row.source_updated_at,
            embedding_model_id: modelId,
            vector_version: vectorVersion,
        };
        return { id, vector: Array.from(vectors[idx]), payload };
    });
}
export async function syncCreatorTagVectors(rows, qdrant, embeddingProvider, schema, vectorVersion) {
    let points;
    try {
        points = await buildVectorPoints(rows, embeddingProvider, vectorVersion);
    }
    catch (err) {
        const e = err;
        if (e.code === "QDRANT_UNAVAILABLE") {
            return { success: false, error: { code: "QDRANT_UNAVAILABLE", message: e.message } };
        }
        throw err;
    }
    if (points.length === 0) {
        return { success: false, error: { code: "NO_TAGS_TO_SYNC", message: "No content_tags or grow_tags found in source rows" } };
    }
    try {
        await qdrant.ensureCollection(schema);
    }
    catch (err) {
        const e = err;
        if (e.code === "QDRANT_UNAVAILABLE") {
            return { success: false, error: { code: "QDRANT_UNAVAILABLE", message: e.message } };
        }
        throw err;
    }
    try {
        await qdrant.upsert(points);
    }
    catch (err) {
        const e = err;
        if (e.code === "QDRANT_UNAVAILABLE") {
            return { success: false, error: { code: "QDRANT_UNAVAILABLE", message: e.message } };
        }
        throw err;
    }
    return { success: true, upserted: points.length, pointIds: points.map((p) => p.id) };
}
