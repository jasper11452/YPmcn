import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakeEmbeddingProvider } from "../dist/config/providers.js";
import { buildCollectionSchema, FakeQdrantClient } from "../dist/vector/qdrant.js";
import { buildVectorPoints, syncCreatorTagVectors } from "../dist/vector/sync.js";

const DIMENSION = 8;
const VERSION = "v1";

function rows() {
  return [
    {
      platform: "xhs",
      platform_account_id: "xhs-1",
      source_table: "xhs_creator_accounts",
      content_tags: ["美妆", "护肤"],
      grow_tags: ["腰部达人"],
      source_updated_at: "2026-07-11T00:00:00Z",
    },
    {
      platform: "dy",
      platform_account_id: "dy-1",
      source_table: "dy_creator_accounts",
      content_tags: ["数码", "测评"],
      grow_tags: [],
      source_updated_at: "2026-07-11T00:00:00Z",
    },
  ];
}

function schema() {
  return buildCollectionSchema({
    url: "fake://test",
    collectionName: "test-creators",
    vectorSize: DIMENSION,
    distance: "Cosine",
  });
}

describe("source-owned vector sync", () => {
  it("builds deterministic content/grow points and syncs them", async () => {
    const embedding = createFakeEmbeddingProvider(DIMENSION);
    const first = await buildVectorPoints(rows(), embedding, VERSION);
    const second = await buildVectorPoints(rows(), embedding, VERSION);
    assert.equal(first.length, 3);
    assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id));

    const qdrant = new FakeQdrantClient();
    const result = await syncCreatorTagVectors(rows(), qdrant, embedding, schema(), VERSION);
    assert.equal(result.success, true);
    assert.equal(qdrant.pointCount, 3);
  });

  it("reports empty tags and unavailable storage without partial writes", async () => {
    const embedding = createFakeEmbeddingProvider(DIMENSION);
    const empty = await syncCreatorTagVectors([
      { ...rows()[0], content_tags: [], grow_tags: [] },
    ], new FakeQdrantClient(), embedding, schema(), VERSION);
    assert.equal(empty.success, false);
    assert.equal(empty.error.code, "NO_TAGS_TO_SYNC");

    const unavailableStore = new FakeQdrantClient({ unavailable: true });
    const unavailable = await syncCreatorTagVectors(rows(), unavailableStore, embedding, schema(), VERSION);
    assert.equal(unavailable.success, false);
    assert.equal(unavailable.error.code, "QDRANT_UNAVAILABLE");
    assert.equal(unavailableStore.pointCount, 0);
  });
});

