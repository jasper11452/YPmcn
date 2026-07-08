import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeEmbeddingProvider } from "../config/providers.js";
import { buildCollectionSchema, FakeQdrantClient } from "./qdrant.js";
import { buildVectorPoints, syncCreatorTagVectors, } from "./sync.js";
// ─── Fixtures ────────────────────────────────────────────────────────────────
const EMBEDDING_DIM = 8;
const VECTOR_VERSION = "v1";
function makeQdrantConfig(overrides) {
    return {
        url: "http://fake:6333",
        collectionName: "test_creators",
        vectorSize: EMBEDDING_DIM,
        distance: "Cosine",
        ...overrides,
    };
}
function makeFakeRows() {
    return [
        {
            platform: "xhs",
            platform_account_id: "xhs_user_001",
            source_table: "xhs_creator",
            content_tags: ["美妆", "护肤", "好物分享"],
            grow_tags: ["头部达人", "高转化"],
            source_updated_at: "2025-07-01T10:00:00Z",
            display_name: "小红花",
            profile_url: "https://www.xiaohongshu.com/user/001",
        },
        {
            platform: "dy",
            platform_account_id: "dy_user_002",
            source_table: "dy_creator",
            content_tags: ["数码", "评测"],
            grow_tags: ["腰部达人"],
            source_updated_at: "2025-07-02T12:00:00Z",
            display_name: "数码小王",
        },
    ];
}
// ─── Test 1: fake xhs/dy rows produce content/grow points ────────────────────
describe("buildVectorPoints", () => {
    it("produces separate content and grow points with identity payload", async () => {
        const rows = makeFakeRows();
        const embedding = createFakeEmbeddingProvider(EMBEDDING_DIM);
        const points = await buildVectorPoints(rows, embedding, VECTOR_VERSION);
        // 2 rows × 2 tag types = 4 points
        assert.equal(points.length, 4);
        // Check xhs content point
        const xhsContent = points.find((p) => p.payload.platform === "xhs" &&
            p.payload.platform_account_id === "xhs_user_001" &&
            p.payload.tag_type === "content");
        assert.ok(xhsContent, "xhs content point should exist");
        assert.equal(xhsContent.id, "xhs:xhs_user_001:content:v1");
        assert.deepEqual(xhsContent.payload.raw_tags, ["美妆", "护肤", "好物分享"]);
        assert.equal(xhsContent.payload.vector_version, VECTOR_VERSION);
        assert.equal(xhsContent.payload.embedding_model_id, `fake-embedding-${EMBEDDING_DIM}`);
        assert.equal(xhsContent.vector.length, EMBEDDING_DIM);
        // Check dy grow point
        const dyGrow = points.find((p) => p.payload.platform === "dy" &&
            p.payload.platform_account_id === "dy_user_002" &&
            p.payload.tag_type === "grow");
        assert.ok(dyGrow, "dy grow point should exist");
        assert.equal(dyGrow.id, "dy:dy_user_002:grow:v1");
        assert.deepEqual(dyGrow.payload.raw_tags, ["腰部达人"]);
    });
    it("produces deterministic point IDs", async () => {
        const rows = makeFakeRows();
        const embedding = createFakeEmbeddingProvider(EMBEDDING_DIM);
        const points1 = await buildVectorPoints(rows, embedding, VECTOR_VERSION);
        const points2 = await buildVectorPoints(rows, embedding, VECTOR_VERSION);
        assert.deepEqual(points1.map((p) => p.id).sort(), points2.map((p) => p.id).sort());
    });
});
// ─── Test 2: empty tag rows return NO_TAGS_TO_SYNC ───────────────────────────
describe("syncCreatorTagVectors — NO_TAGS_TO_SYNC", () => {
    it("returns NO_TAGS_TO_SYNC when all rows have empty tags", async () => {
        const rows = [
            {
                platform: "xhs",
                platform_account_id: "xhs_empty",
                source_table: "xhs_creator",
                content_tags: null,
                grow_tags: undefined,
                source_updated_at: "2025-07-01T00:00:00Z",
            },
            {
                platform: "dy",
                platform_account_id: "dy_empty",
                source_table: "dy_creator",
                content_tags: [],
                grow_tags: "[]",
                source_updated_at: "2025-07-01T00:00:00Z",
            },
        ];
        const embedding = createFakeEmbeddingProvider(EMBEDDING_DIM);
        const qdrant = new FakeQdrantClient();
        const schema = buildCollectionSchema(makeQdrantConfig());
        const result = await syncCreatorTagVectors(rows, qdrant, embedding, schema, VECTOR_VERSION);
        assert.equal(result.success, false);
        if (!result.success) {
            assert.equal(result.error.code, "NO_TAGS_TO_SYNC");
        }
        assert.equal(qdrant.points.length, 0);
    });
});
// ─── Test 3: Qdrant unavailable returns QDRANT_UNAVAILABLE ───────────────────
describe("syncCreatorTagVectors — QDRANT_UNAVAILABLE", () => {
    it("returns QDRANT_UNAVAILABLE when fake client is unavailable", async () => {
        const rows = makeFakeRows();
        const embedding = createFakeEmbeddingProvider(EMBEDDING_DIM);
        const qdrant = new FakeQdrantClient({ unavailable: true });
        const schema = buildCollectionSchema(makeQdrantConfig());
        const result = await syncCreatorTagVectors(rows, qdrant, embedding, schema, VECTOR_VERSION);
        assert.equal(result.success, false);
        if (!result.success) {
            assert.equal(result.error.code, "QDRANT_UNAVAILABLE");
            assert.ok(result.error.message.length > 0);
        }
        // No points should have been upserted
        assert.equal(qdrant.points.length, 0);
        assert.equal(qdrant.schemas.length, 0);
    });
});
// ─── Test 4: collection schema includes required payload indexes ─────────────
describe("buildCollectionSchema", () => {
    it("includes payload indexes for identity fields", () => {
        const config = makeQdrantConfig();
        const schema = buildCollectionSchema(config);
        assert.equal(schema.collectionName, "test_creators");
        assert.equal(schema.vectorSize, EMBEDDING_DIM);
        assert.equal(schema.distance, "Cosine");
        const requiredIndexes = [
            "platform",
            "platform_account_id",
            "tag_type",
            "source_updated_at",
            "vector_version",
        ];
        for (const idx of requiredIndexes) {
            assert.ok(schema.payloadIndexes.includes(idx), `payloadIndexes should include "${idx}"`);
        }
    });
});
// ─── Integration: successful sync ────────────────────────────────────────────
describe("syncCreatorTagVectors — success", () => {
    it("upserts points and returns success", async () => {
        const rows = makeFakeRows();
        const embedding = createFakeEmbeddingProvider(EMBEDDING_DIM);
        const qdrant = new FakeQdrantClient();
        const schema = buildCollectionSchema(makeQdrantConfig());
        const result = await syncCreatorTagVectors(rows, qdrant, embedding, schema, VECTOR_VERSION);
        assert.equal(result.success, true);
        if (result.success) {
            assert.equal(result.upserted, 4);
            assert.equal(result.pointIds.length, 4);
        }
        assert.equal(qdrant.schemas.length, 1);
        assert.equal(qdrant.points.length, 4);
    });
});
