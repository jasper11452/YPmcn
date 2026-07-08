import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeQdrantClient, buildCollectionSchema } from "./qdrant.js";
import { reciprocalRankFusion } from "./rrf.js";
import { createFakeEmbeddingProvider } from "../config/providers.js";
import { buildVectorPoints } from "./sync.js";

const DIM = 8;
const VERSION = "v1";

function makeQdrantConfig() {
  return {
    url: "http://fake:6333",
    collectionName: "test_creators",
    vectorSize: DIM,
    distance: "Cosine",
  };
}

function makeRows() {
  return [
    {
      platform: "xhs",
      platform_account_id: "xhs_001",
      source_table: "xhs_creator",
      content_tags: ["美妆", "护肤", "好物分享"],
      grow_tags: ["头部达人"],
      source_updated_at: "2025-07-01T00:00:00Z",
      display_name: "小红花",
    },
    {
      platform: "xhs",
      platform_account_id: "xhs_002",
      source_table: "xhs_creator",
      content_tags: ["沈阳探店", "沈阳本地生活", "美食"],
      grow_tags: ["腰部达人"],
      source_updated_at: "2025-07-01T00:00:00Z",
      display_name: "沈阳探店王",
    },
    {
      platform: "dy",
      platform_account_id: "dy_001",
      source_table: "dy_creator",
      content_tags: ["数码", "评测", "AI教程"],
      grow_tags: ["头部达人"],
      source_updated_at: "2025-07-01T00:00:00Z",
      display_name: "数码小王",
    },
    {
      platform: "dy",
      platform_account_id: "dy_002",
      source_table: "dy_creator",
      content_tags: ["穿搭", "OOTD", "时尚", "沈阳"],
      grow_tags: ["腰部达人"],
      source_updated_at: "2025-07-01T00:00:00Z",
      display_name: "沈阳潮人",
    },
    {
      platform: "dy",
      platform_account_id: "dy_003",
      source_table: "dy_creator",
      content_tags: ["美食", "探店", "广东", "粤语"],
      grow_tags: ["腰部达人"],
      source_updated_at: "2025-07-01T00:00:00Z",
      display_name: "广东美食家",
    },
  ];
}

async function seedQdrant() {
  const embedding = createFakeEmbeddingProvider(DIM);
  const qdrant = new FakeQdrantClient();
  const schema = buildCollectionSchema(makeQdrantConfig());
  const points = await buildVectorPoints(makeRows(), embedding, VERSION);
  await qdrant.ensureCollection(schema);
  await qdrant.upsert(points);
  return qdrant;
}

describe("reciprocalRankFusion", () => {
  it("fuses two result lists with RRF k=60", () => {
    const dense = [
      { id: "a", score: 0.9, payload: { name: "A" } },
      { id: "b", score: 0.8, payload: { name: "B" } },
      { id: "c", score: 0.7, payload: { name: "C" } },
    ];
    const sparse = [
      { id: "b", score: 1.0, payload: { name: "B" } },
      { id: "c", score: 0.9, payload: { name: "C" } },
      { id: "d", score: 0.8, payload: { name: "D" } },
    ];
    const fused = reciprocalRankFusion(dense, sparse, 60);
    assert.ok(fused.length >= 4, "should include all unique items");
    assert.equal(fused[0].id, "b", "b should rank first (rank 2 in both lists)");
  });

  it("returns empty array for empty inputs", () => {
    const fused = reciprocalRankFusion([], [], 60);
    assert.equal(fused.length, 0);
  });

  it("preserves order from single list", () => {
    const dense = [
      { id: "x", score: 1.0, payload: {} },
      { id: "y", score: 0.5, payload: {} },
    ];
    const fused = reciprocalRankFusion(dense, [], 60);
    assert.equal(fused[0].id, "x");
    assert.equal(fused[1].id, "y");
  });
});

describe("FakeQdrantClient.bm25Search", () => {
  it("returns results sorted by BM25 score", async () => {
    const qdrant = await seedQdrant();
    const results = qdrant.bm25Search({ query: "沈阳 探店", limit: 10 });
    assert.ok(results.length > 0, "should return results");
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, "results should be sorted descending");
    }
  });

  it("scores exact tag matches higher than unrelated", async () => {
    const qdrant = await seedQdrant();
    const results = qdrant.bm25Search({ query: "沈阳探店 沈阳本地生活", limit: 10 });
    const top2 = results.slice(0, 2);
    const hasShenyang = top2.some((r) => r.payload.raw_tags.some((t) => t.includes("沈阳")));
    assert.ok(hasShenyang, "top results should include 沈阳 matches");
  });

  it("respects limit parameter", async () => {
    const qdrant = await seedQdrant();
    const results = qdrant.bm25Search({ query: "穿搭", limit: 2 });
    assert.ok(results.length <= 2);
  });
});

describe("FakeQdrantClient.search (dense) unchanged", () => {
  it("still works for cosine similarity", async () => {
    const qdrant = await seedQdrant();
    const embedding = createFakeEmbeddingProvider(DIM);
    const [vec] = await embedding.embed(["美妆 护肤"]);
    const results = await qdrant.search({ vector: Array.from(vec), limit: 10, score_threshold: -1 });
    assert.ok(results.length > 0, "dense search should still work");
  });
});
