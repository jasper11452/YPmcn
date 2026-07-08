/**
 * Sync pipeline: converts source rows into Qdrant vector points.
 *
 * No real MySQL client — CreatorSourceRow represents a fake row.
 * Later todos wire real MySQL queries that produce these rows.
 */
// ─── Tag extraction helpers ──────────────────────────────────────────────────
/**
 * Extract a string array from an unknown value.
 * Handles: string[], JSON string of array, null/undefined → empty array.
 */
function extractTags(raw) {
    if (raw === null || raw === undefined) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw.filter((t) => typeof t === "string");
    }
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter((t) => typeof t === "string");
            }
        }
        catch {
            // Not JSON — treat as single tag
            return raw.trim().length > 0 ? [raw] : [];
        }
    }
    return [];
}
/**
 * Deterministic normalization: join sorted tags with "|" separator.
 * Simple and stable — later todos can consolidate with query normalization.
 */
function normalizeText(tags) {
    return [...tags].sort().join("|");
}
// ─── Point ID ────────────────────────────────────────────────────────────────
/**
 * Deterministic point ID: `${platform}:${platform_account_id}:${tag_type}:${vectorVersion}`
 */
function buildPointId(platform, platformAccountId, tagType, vectorVersion) {
    return `${platform}:${platformAccountId}:${tagType}:${vectorVersion}`;
}
// ─── Build vector points ─────────────────────────────────────────────────────
/**
 * Convert source rows into vector points.
 * Creates separate points for content tags and grow tags when each is non-empty.
 */
export async function buildVectorPoints(rows, embeddingProvider, vectorVersion) {
    // Collect all texts that need embedding, with metadata
    const items = [];
    for (const row of rows) {
        const contentTags = extractTags(row.content_tags);
        const growTags = extractTags(row.grow_tags);
        if (contentTags.length > 0) {
            items.push({
                text: normalizeText(contentTags),
                row,
                tagType: "content",
                tags: contentTags,
            });
        }
        if (growTags.length > 0) {
            items.push({
                text: normalizeText(growTags),
                row,
                tagType: "grow",
                tags: growTags,
            });
        }
    }
    if (items.length === 0) {
        return [];
    }
    // Batch embed all texts
    const texts = items.map((item) => item.text);
    const vectors = await embeddingProvider.embed(texts);
    // Assemble points
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
        return {
            id,
            vector: Array.from(vectors[idx]),
            payload,
        };
    });
}
// ─── Sync function ───────────────────────────────────────────────────────────
/**
 * Sync creator tag vectors to Qdrant.
 * Ensures collection exists, builds points, upserts them.
 * Returns a SyncResult indicating success or failure.
 */
export async function syncCreatorTagVectors(rows, qdrant, embeddingProvider, schema, vectorVersion) {
    // Build points first (may fail if embedding provider fails)
    let points;
    try {
        points = await buildVectorPoints(rows, embeddingProvider, vectorVersion);
    }
    catch (err) {
        const code = err?.code;
        if (code === "QDRANT_UNAVAILABLE") {
            return {
                success: false,
                error: {
                    code: "QDRANT_UNAVAILABLE",
                    message: err instanceof Error ? err.message : "Qdrant is unavailable",
                },
            };
        }
        throw err;
    }
    if (points.length === 0) {
        return {
            success: false,
            error: {
                code: "NO_TAGS_TO_SYNC",
                message: "No content_tags or grow_tags found in source rows",
            },
        };
    }
    // Ensure collection exists
    try {
        await qdrant.ensureCollection(schema);
    }
    catch (err) {
        const code = err?.code;
        if (code === "QDRANT_UNAVAILABLE") {
            return {
                success: false,
                error: {
                    code: "QDRANT_UNAVAILABLE",
                    message: err instanceof Error ? err.message : "Qdrant is unavailable",
                },
            };
        }
        throw err;
    }
    // Upsert points
    try {
        await qdrant.upsert(points);
    }
    catch (err) {
        const code = err?.code;
        if (code === "QDRANT_UNAVAILABLE") {
            return {
                success: false,
                error: {
                    code: "QDRANT_UNAVAILABLE",
                    message: err instanceof Error ? err.message : "Qdrant is unavailable",
                },
            };
        }
        throw err;
    }
    return {
        success: true,
        upserted: points.length,
        pointIds: points.map((p) => p.id),
    };
}
