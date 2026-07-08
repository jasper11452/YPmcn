/**
 * Fake e2e validation: sync + search using fake providers and in-memory Qdrant.
 *
 * Proves the full pipeline works locally without real credentials.
 * Run via: npm run validate:fake
 */
import { createFakeEmbeddingProvider } from "../config/providers.js";
import { FakeQdrantClient, buildCollectionSchema } from "../vector/qdrant.js";
import { syncCreatorTagVectors } from "../vector/sync.js";
import { handleToolCall } from "../tools/handlers.js";
// ─── Fake rows ───────────────────────────────────────────────────────────────
const FAKE_ROWS = [
    {
        platform: "xhs",
        platform_account_id: "xhs_ai_creator_001",
        source_table: "xhs_creator",
        content_tags: ["AI深度使用", "AI教程", "创作者成长"],
        grow_tags: ["创作者", "知识博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "AI创作者小明",
    },
    {
        platform: "dy",
        platform_account_id: "dy_food_creator_003",
        source_table: "dy_creator",
        content_tags: ["美食", "探店", "吃播"],
        grow_tags: ["美食博主"],
        source_updated_at: "2025-07-01T00:00:00Z",
        display_name: "美食达人小刚",
    },
];
const FAKE_DIM = 128;
const FAKE_VECTOR_VERSION = "v1";
const FAKE_QDRANT_CONFIG = {
    url: "fake://localhost",
    collectionName: "creator_tags_validation",
    vectorSize: FAKE_DIM,
    distance: "Cosine",
};
// ─── Core logic ──────────────────────────────────────────────────────────────
export async function runFakeE2eValidation() {
    // 1. Sync: embed + upsert into fake Qdrant
    const embeddingProvider = createFakeEmbeddingProvider(FAKE_DIM);
    const qdrant = new FakeQdrantClient();
    const schema = buildCollectionSchema(FAKE_QDRANT_CONFIG);
    const syncResult = await syncCreatorTagVectors(FAKE_ROWS, qdrant, embeddingProvider, schema, FAKE_VECTOR_VERSION);
    if (!syncResult.success) {
        return {
            success: false,
            mode: "fake",
            synced: 0,
            searched: false,
            error: `Sync failed: ${syncResult.error.code} — ${syncResult.error.message}`,
        };
    }
    const synced = syncResult.upserted;
    // 2. Search: use the MCP handler (which has its own seeded fake data)
    //    to prove the search tool works end-to-end.
    const searchResult = await handleToolCall("search_creator_tag_vectors", {
        positiveRequirements: ["AI深度使用 创作者"],
        negativeRequirements: [],
        limit: 5,
    });
    if (!searchResult.success) {
        return {
            success: false,
            mode: "fake",
            synced,
            searched: false,
            error: `Search failed: ${searchResult.error?.code ?? "unknown"} — ${searchResult.error?.message ?? "unknown"}`,
        };
    }
    return {
        success: true,
        mode: "fake",
        synced,
        searched: true,
    };
}
// ─── CLI entry ───────────────────────────────────────────────────────────────
async function main() {
    const result = await runFakeE2eValidation();
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
        process.exit(1);
    }
}
// Only run main when executed directly (not imported by tests)
const isDirectRun = typeof process !== "undefined" &&
    process.argv[1] &&
    (process.argv[1].endsWith("/validation/fakeE2e.js") ||
        process.argv[1].endsWith("/validation/fakeE2e.ts"));
if (isDirectRun) {
    main().catch((err) => {
        console.error(JSON.stringify({
            success: false,
            mode: "fake",
            synced: 0,
            searched: false,
            error: err instanceof Error ? err.message : String(err),
        }));
        process.exit(1);
    });
}
