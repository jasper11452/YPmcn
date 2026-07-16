import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { MysqlReadonlySource, mysqlSourceConfigFromEnv, validateTableIdentifier } from "../dist/db/mysql-source.js";
import { createDashScopeEmbeddingProvider, createDashScopeReranker } from "../dist/providers/dashscope.js";
import { normalizeAndRedact, projectCreatorText } from "../dist/source/projection.js";
import { TOOL_DEFINITIONS } from "../dist/tools/listTools.js";
import { buildNamedVectorPoints, LocalVectorPipeline } from "../dist/vector/pipeline.js";
import { RealQdrantClient } from "../dist/vector/real-qdrant.js";

function config(overrides = {}) {
  return {
    host: "db", port: 3306, user: "u", password: "secret", database: "d",
    dyTable: "dy_mz", xhsTable: "xhs_mz", projectTable: "core_project",
    allowedTables: ["dy_mz", "xhs_mz", "core_project"],
    ...overrides,
  };
}

function rawRow(overrides = {}) {
  return {
    douyinId: "dy-7",
    update_time: "2026-07-14 12:00:00.000",
    kwUid: "kw-7",
    province: "辽宁",
    city: "沈阳",
    follower_count: 12000,
    date: "2026-07-14",
    description: "徒步露营",
    talentTypeLabel: "户外达人",
    tagBrand: "户外用品",
    ...overrides,
  };
}

function creator(overrides = {}) {
  return {
    platform: "douyin",
    kwUid: "kw-7",
    sourceTable: "dy_mz",
    sourceRowId: "kw-7",
    sourceSnapshotDate: "2026-07-14",
    sourceUpdatedAt: "2026-07-14T12:00:00.000Z",
    description: "徒步露营",
    province: "辽宁",
    city: "沈阳",
    followerCount: 12000,
    dataJson: { talentTypeLabel: "户外达人", tagBrand: "户外用品" },
    ...overrides,
  };
}

function namedVectorPoint(id, overrides = {}) {
  return {
    id: String(id),
    vector: { content: [1, 0], commercial: [0, 1] },
    payload: {
      platform: "douyin", kwUid: `kw-${id}`, source_table: "dy_mz", source_row_id: String(id),
      source_snapshot_date: "2026-07-14", source_updated_at: "2026-07-14T12:00:00Z",
      embedding_model_id: "text-embedding-v4", vector_version: "local-v1",
      commercial_vector_available: true,
    },
    ...overrides,
  };
}

it("preserves the three public operation tool interfaces", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
    "sync_creator_tag_vectors", "search_creator_tag_vectors", "health_check_vector_store",
  ]);
  assert.deepEqual(TOOL_DEFINITIONS[0].inputSchema.required, []);
  assert.deepEqual(TOOL_DEFINITIONS[1].inputSchema.required, ["positiveRequirements", "negativeRequirements"]);
  assert.equal(TOOL_DEFINITIONS[0].inputSchema.properties.cursor.type, "string");
  assert.equal(TOOL_DEFINITIONS[1].inputSchema.properties.queryText.type, "string");
  assert.deepEqual(TOOL_DEFINITIONS[1].inputSchema.properties.projectId.type, ["string", "number"]);
});

describe("projection and redaction", () => {
  it("keeps allowed semantics and removes contact, URL, ID-like, metrics and region fields", () => {
    const projected = projectCreatorText({
      description: "联系 13800138000 mail a@example.com https://example.com/u",
      data_json: {
        description: "户外露营 token ABCD1234567890123456",
        contentThemeLabel: ["徒步"],
        tagBrand: "户外用品",
        province: "辽宁",
        nickname: "Alice",
        followerCount: 99999,
        price: 3000,
        numericOnly: "12345",
      },
    });
    assert.match(projected.contentText, /户外露营/);
    assert.match(projected.contentText, /\[PHONE\]/);
    assert.match(projected.contentText, /\[EMAIL\]/);
    assert.match(projected.contentText, /\[URL\]/);
    assert.match(projected.contentText, /\[ID\]/);
    assert.equal(projected.commercialText, "户外用品");
    assert.doesNotMatch(JSON.stringify(projected), /辽宁|Alice|99999|3000/);
    assert.equal(normalizeAndRedact("  多行\n  空格  "), "多行 空格");
  });
});

describe("DashScope providers", () => {
  it("sends approved embedding shape and strictly validates dimensions", async () => {
    let request;
    const provider = createDashScopeEmbeddingProvider({
      apiKey: "key", dimension: 3, model: "text-embedding-v4", maxRetries: 0,
      fetch: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) };
        return Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] });
      },
    });
    const result = await provider.embed(["已脱敏文本"]);
    assert.match(request.url, /compatible-mode\/v1\/embeddings$/);
    assert.deepEqual(request.body, { model: "text-embedding-v4", input: ["已脱敏文本"], dimensions: 3 });
    assert.deepEqual(Array.from(result[0]), [1, 2, 3]);

    const invalid = createDashScopeEmbeddingProvider({
      apiKey: "key", dimension: 3, maxRetries: 0,
      fetch: async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
    });
    await assert.rejects(invalid.embed(["private-query"]), (error) => {
      assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
      assert.doesNotMatch(error.message, /private-query/);
      return true;
    });
  });

  it("sends qwen3-rerank requests and never copies response text into HTTP errors", async () => {
    let request;
    const reranker = createDashScopeReranker({
      apiKey: "key", workspaceId: "workspace", model: "qwen3-rerank", maxRetries: 0,
      fetch: async (url, init) => {
        request = { url, body: JSON.parse(init.body) };
        return Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
      },
    });
    assert.deepEqual(await reranker.rerank("query", ["a", "b"], 1), [{ index: 1, score: 0.9 }]);
    assert.equal(request.url, "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks");
    assert.deepEqual(request.body, {
      model: "qwen3-rerank", query: "query", documents: ["a", "b"], top_n: 2,
    });

    const failed = createDashScopeReranker({ apiKey: "key", workspaceId: "workspace", maxRetries: 0, fetch: async () => new Response("secret query echoed", { status: 400 }) });
    await assert.rejects(failed.rerank("secret query", ["doc"], 1), (error) => {
      assert.doesNotMatch(error.message, /secret query/);
      return error.code === "PROVIDER_HTTP_ERROR";
    });
  });
});

describe("official Qdrant SDK adapter", () => {
  it("selects the Qdrant SDK port from the URL protocol and explicit port", () => {
    const cases = [
      ["https://example.com", 443],
      ["https://example.com:7443", 7443],
      ["http://localhost", 6333],
      ["http://localhost:6333", 6333],
    ];

    for (const [url, expectedPort] of cases) {
      const qdrant = new RealQdrantClient({ url, collectionName: "c", vectorSize: 2 });
      assert.equal(qdrant.client._port, expectedPort);
    }
  });

  it("creates named-vector collection, persists a content-only point, queries content and checks health", async () => {
    const calls = [];
    const client = {
      collectionExists: async (collectionName) => { calls.push(["collectionExists", collectionName]); return { exists: false }; },
      createCollection: async (collectionName, options) => { calls.push(["createCollection", collectionName, options]); },
      getCollection: async (collectionName) => { calls.push(["getCollection", collectionName]); return {}; },
      upsert: async (collectionName, options) => { calls.push(["upsert", collectionName, options]); },
      query: async (collectionName, options) => {
        calls.push(["query", collectionName, options]);
        return { points: [{ id: "p", score: 0.8, payload: { platform: "douyin", kwUid: "kw-7" } }] };
      },
      getCollections: async () => { calls.push(["getCollections"]); return { collections: [] }; },
      deleteCollection: async (collectionName) => { calls.push(["deleteCollection", collectionName]); },
    };
    const qdrant = new RealQdrantClient({ url: "http://q", collectionName: "c", vectorSize: 2, client });
    await qdrant.ensureCollection();
    await qdrant.upsert([{ id: "p", vector: { content: [1, 0] }, payload: {
      platform: "douyin", kwUid: "kw-7", source_table: "dy_mz", source_row_id: "kw-7",
      source_snapshot_date: "2026-07-14", source_updated_at: "2026-07-14T12:00:00Z",
      embedding_model_id: "text-embedding-v4", vector_version: "local-v1", commercial_vector_available: false,
    } }]);
    await qdrant.search("content", [1, 0], 5, "douyin");
    await qdrant.health();
    assert.deepEqual(calls[1][2].vectors, {
      content: { size: 2, distance: "Cosine" }, commercial: { size: 2, distance: "Cosine" },
    });
    assert.equal(calls[2][2].points[0].payload.normalized_text, undefined);
    assert.deepEqual(calls[2][2].points[0].vector, { content: [1, 0] });
    assert.equal(calls[3][2].using, "content");
    assert.deepEqual(calls[3][2].filter, { must: [{ key: "platform", match: { value: "douyin" } }] });
  });

  it("validates existing named-vector schema and all vector dimensions", async () => {
    const client = {
      collectionExists: async () => ({ exists: true }),
      getCollection: async () => ({ config: { params: { vectors: {
        content: { size: 3, distance: "Cosine" }, commercial: { size: 3, distance: "Cosine" },
      } } } }),
      createCollection: async () => {}, upsert: async () => {}, query: async () => ({ points: [] }),
      getCollections: async () => ({}), deleteCollection: async () => {},
    };
    const qdrant = new RealQdrantClient({ url: "http://q", collectionName: "c", vectorSize: 2, client });
    await assert.rejects(qdrant.ensureCollection(), /schema mismatch/);
    await assert.rejects(qdrant.upsert([{ id: "p", vector: { content: [1], commercial: [0, 1] }, payload: {
      platform: "douyin", kwUid: "kw-7", source_table: "dy_mz", source_row_id: "kw-7",
      source_snapshot_date: "2026-07-14", source_updated_at: "2026-07-14T12:00:00Z",
      embedding_model_id: "text-embedding-v4", vector_version: "local-v1", commercial_vector_available: true,
    } }]), /exactly 2/);
  });

  it("batches 201 upsert points as 100, 100 and 1", async () => {
    const batches = [];
    const client = {
      upsert: async (_collectionName, options) => { batches.push(options); },
    };
    const qdrant = new RealQdrantClient({ url: "http://q", collectionName: "c", vectorSize: 2, client });

    await qdrant.upsert(Array.from({ length: 201 }, (_, index) => namedVectorPoint(index)));

    assert.deepEqual(batches.map((batch) => batch.points.length), [100, 100, 1]);
    assert.ok(batches.every((batch) => batch.wait === true));
  });

  it("supports a custom upsert batch size", async () => {
    const batchSizes = [];
    const client = {
      upsert: async (_collectionName, options) => { batchSizes.push(options.points.length); },
    };
    const qdrant = new RealQdrantClient({
      url: "http://q", collectionName: "c", vectorSize: 2, upsertBatchSize: 2, client,
    });

    await qdrant.upsert(Array.from({ length: 5 }, (_, index) => namedVectorPoint(index)));

    assert.deepEqual(batchSizes, [2, 2, 1]);
  });

  it("validates every optional commercial vector before issuing any SDK upsert", async () => {
    let upsertCalls = 0;
    const client = {
      upsert: async () => { upsertCalls += 1; },
    };
    const qdrant = new RealQdrantClient({
      url: "http://q", collectionName: "c", vectorSize: 2, upsertBatchSize: 2, client,
    });
    const points = Array.from({ length: 5 }, (_, index) => namedVectorPoint(index));
    points[4] = namedVectorPoint(4, { vector: { content: [1, 0], commercial: [0] } });

    await assert.rejects(qdrant.upsert(points), /commercial vector must contain exactly 2/);

    assert.equal(upsertCalls, 0);
  });

  it("rejects an inconsistent commercial availability marker before write", async () => {
    let upsertCalls = 0;
    const qdrant = new RealQdrantClient({
      url: "http://q",
      collectionName: "c",
      vectorSize: 2,
      client: { upsert: async () => { upsertCalls += 1; } },
    });
    const point = namedVectorPoint("content-only", {
      vector: { content: [1, 0] },
      payload: { ...namedVectorPoint("content-only").payload, commercial_vector_available: true },
    });

    await assert.rejects(qdrant.upsert([point]), /must match the written commercial vector/);
    assert.equal(upsertCalls, 0);
  });
});

it("real Qdrant SDK smoke", { skip: process.env.RUN_QDRANT_SMOKE !== "1" }, async () => {
  const collectionName = `vector_mcp_smoke_${process.pid}_${Date.now()}`;
  const qdrant = new RealQdrantClient({
    url: process.env.QDRANT_URL ?? "http://localhost:6333",
    collectionName,
    vectorSize: 2,
  });
  try {
    await qdrant.health();
    await qdrant.ensureCollection();
    await qdrant.upsert([{ id: randomUUID(), vector: { content: [1, 0], commercial: [0, 1] }, payload: {
      platform: "douyin", kwUid: "smoke", source_table: "smoke", source_row_id: "1",
      source_snapshot_date: "2026-07-15", source_updated_at: "2026-07-15T00:00:00Z",
      embedding_model_id: "smoke", vector_version: "smoke", commercial_vector_available: true,
    } }]);
    const hits = await qdrant.search("content", [1, 0], 1, "douyin");
    assert.equal(hits[0]?.payload.kwUid, "smoke");
  } finally {
    await qdrant.deleteCollection().catch(() => {});
  }
});

describe("read-only MySQL source", () => {
  it("prefers YP_MYSQL names and generates fixed full/incremental SELECTs", async () => {
    const envConfig = mysqlSourceConfigFromEnv({
      YP_MYSQL_HOST: "yp-host", MYSQL_HOST: "legacy", YP_MYSQL_USER: "yp-user",
      YP_MYSQL_PASSWORD: "pw", YP_MYSQL_DATABASE: "db",
    });
    assert.equal(envConfig.host, "yp-host");
    const calls = [];
    const source = new MysqlReadonlySource(config(), { query: async (sql, values) => { calls.push({ sql, values }); return [[rawRow()]]; } });
    const full = await source.readCreators("douyin");
    const incremental = await source.readCreators("douyin", { cursor: "2026-07-14", limit: 10 });
    assert.equal(full.rows[0].kwUid, "kw-7");
    assert.match(calls[0].sql, /^SELECT /);
    assert.doesNotMatch(calls[0].sql, /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
    assert.deepEqual(calls[0].values, []);
    assert.doesNotMatch(calls[0].sql, / LIMIT \?$/);
    assert.match(calls[1].sql, /WHERE update_time > \? ORDER BY update_time ASC, kwUid ASC LIMIT \?$/);
    assert.deepEqual(calls[1].values, ["2026-07-14", 10]);
    assert.equal(incremental.cursor, "2026-07-14 12:00:00.000");
  });

  it("rejects unallowlisted tables, reports missing XHS, and loads project description", async () => {
    assert.throws(() => validateTableIdentifier("evil; DROP TABLE x", ["evil"]), /allowlist/);
    const calls = [];
    const source = new MysqlReadonlySource(config({ xhsTable: undefined }), { query: async (sql, values) => { calls.push({ sql, values }); return [[{ description: "露营项目 13800138000" }]]; } });
    assert.deepEqual(await source.readCreators("xiaohongshu"), {
      status: "unavailable", platform: "xiaohongshu", rows: [], reason: "source_not_configured",
    });
    assert.equal(await source.loadProjectDescription(9), "露营项目 13800138000");
    assert.match(calls[0].sql, /^SELECT description FROM `core_project` WHERE id = \? LIMIT 1$/);
  });

  it("reports configured XHS table-not-found without fake success", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
    const source = new MysqlReadonlySource(config(), {
      query: async () => { throw missing; },
    });
    assert.deepEqual(await source.readCreators("xiaohongshu"), {
      status: "unavailable", platform: "xiaohongshu", rows: [], reason: "source_table_missing",
    });
  });
});

describe("sync identity and search pipeline", () => {
  it("builds mixed points with ordered provider inputs and skips only missing content", async () => {
    const providerInputs = [];
    const embedding = {
      modelId: () => "text-embedding-v4",
      embed: async (texts) => {
        providerInputs.push([...texts]);
        return texts.map((_, index) => new Float32Array([index, 1]));
      },
    };
    const rows = [
      creator(),
      creator({ kwUid: "kw-content", description: "纯内容", dataJson: { contentThemeLabel: "测评" } }),
      creator({ kwUid: "kw-commercial-only", description: undefined, dataJson: { tagBrand: "品牌" } }),
    ];
    const first = await buildNamedVectorPoints(rows, embedding, "local-v1");
    const second = await buildNamedVectorPoints(rows, embedding, "local-v1");
    assert.equal(first.points[0].id, second.points[0].id);
    assert.equal(first.skipped, 1);
    assert.deepEqual(providerInputs[0], ["徒步露营 | 户外达人", "户外用品", "纯内容 | 测评"]);
    assert.deepEqual(Object.keys(first.points[0].vector).sort(), ["commercial", "content"]);
    assert.deepEqual(first.points[0].vector, { content: [0, 1], commercial: [1, 1] });
    assert.deepEqual(first.points[1].vector, { content: [2, 1] });
    assert.equal(first.points[0].payload.commercial_vector_available, true);
    assert.equal(first.points[1].payload.commercial_vector_available, false);
    const serializedPayload = JSON.stringify(first.points[0].payload);
    assert.doesNotMatch(serializedPayload, /徒步|户外用品|profile|normalized|raw_tags/);
  });

  it("rejects an embedding response whose count cannot preserve input ordering", async () => {
    const embedding = { modelId: () => "e", embed: async () => [new Float32Array([1, 0])] };
    await assert.rejects(buildNamedVectorPoints([creator()], embedding, "v"), /unexpected vector count/);
  });

  it("supports idempotent full sync and explicit manual incremental cursor", async () => {
    const reads = [];
    const upserts = [];
    const source = {
      readCreators: async (_platform, options) => {
        reads.push(options);
        const row = options.cursor ? creator({ sourceUpdatedAt: "2026-07-15T12:00:00.000Z" }) : creator();
        return { status: "available", platform: "douyin", rows: [row], cursor: row.sourceUpdatedAt };
      },
      rehydrate: async () => [], loadProjectDescription: async () => null,
    };
    const pipeline = new LocalVectorPipeline({
      source,
      embedding: { modelId: () => "e", embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
      qdrant: { ensureCollection: async () => {}, upsert: async (points) => upserts.push(points), search: async () => [], health: async () => ({ ok: true }) },
      reranker: { modelId: () => "r", rerank: async () => [] }, vectorVersion: "v",
    });
    const first = await pipeline.sync("douyin");
    await pipeline.sync("douyin");
    const incremental = await pipeline.sync("douyin", { cursor: first.cursor });
    assert.deepEqual(reads, [{ cursor: undefined, limit: undefined }, { cursor: undefined, limit: undefined }, { cursor: first.cursor, limit: undefined }]);
    assert.equal(upserts[0][0].id, upserts[1][0].id);
    assert.equal(upserts[1][0].id, upserts[2][0].id);
    assert.equal(incremental.counts.upserted, 1);
  });

  it("loads/redacts project query, rehydrates, applies filters, and reranks without persisting scores", async () => {
    const embedded = [];
    const source = {
      loadProjectDescription: async () => "露营 联系13800138000",
      rehydrate: async () => [creator()],
      readCreators: async () => ({ status: "available", platform: "douyin", rows: [creator()] }),
    };
    const pipeline = new LocalVectorPipeline({
      source,
      embedding: { modelId: () => "e", embed: async (texts) => { embedded.push(...texts); return texts.map(() => new Float32Array([1, 0])); } },
      qdrant: {
        search: async (name) => [{ id: name, score: 0.5, payload: {
          platform: "douyin", kwUid: "kw-7", commercial_vector_available: true,
        } }],
        ensureCollection: async () => {}, upsert: async () => {}, health: async () => ({ ok: true }),
      },
      reranker: { modelId: () => "r", rerank: async (_q, docs) => docs.map((_, index) => ({ index, score: 0.7 })) },
      vectorVersion: "v",
    });
    const result = await pipeline.search({ projectId: 3, platform: "douyin", filters: { region: "沈阳", followerMin: 1000 } });
    assert.equal(result.success, true);
    assert.equal(result.retrieval_mode, "local-vector");
    assert.match(embedded[0], /\[PHONE\]/);
    assert.doesNotMatch(JSON.stringify(result), /score/);
    assert.equal(result.matches[0].provenance.mysql_revalidated, true);
    assert.equal(result.matches[0].provenance.commercial_vector_available, true);
  });

  it("merges content-only hits without a missing-commercial penalty", async () => {
    const contentOnly = creator({ kwUid: "kw-content", description: "纯内容", dataJson: {} });
    const both = creator({ kwUid: "kw-both" });
    let rerankDocuments;
    const pipeline = new LocalVectorPipeline({
      source: {
        loadProjectDescription: async () => null,
        readCreators: async () => ({ status: "available", platform: "douyin", rows: [] }),
        rehydrate: async () => [contentOnly, both],
      },
      embedding: { modelId: () => "e", embed: async (texts) => texts.map(() => new Float32Array([1, 0])) },
      qdrant: {
        search: async (name) => name === "content" ? [
          { id: "content", score: 0.9, payload: { platform: "douyin", kwUid: "kw-content", commercial_vector_available: false } },
          { id: "both", score: 0.8, payload: { platform: "douyin", kwUid: "kw-both", commercial_vector_available: true } },
        ] : [
          { id: "both", score: 0.95, payload: { platform: "douyin", kwUid: "kw-both", commercial_vector_available: true } },
        ],
        ensureCollection: async () => {}, upsert: async () => {}, health: async () => ({ ok: true }),
      },
      reranker: {
        modelId: () => "r",
        rerank: async (_query, docs) => {
          rerankDocuments = docs;
          return docs.map((_, index) => ({ index, score: 1 - index }));
        },
      },
      vectorVersion: "v",
    });

    const result = await pipeline.search({ queryText: "露营", platform: "douyin" });

    assert.deepEqual(rerankDocuments, ["纯内容", "徒步露营 | 户外达人 户外用品"]);
    assert.deepEqual(result.matches.map((match) => match.kwUid), ["kw-content", "kw-both"]);
    assert.deepEqual(result.matches.map((match) => match.provenance.commercial_vector_available), [false, true]);
  });

  it("returns explicit SQL-only degradation and stable failure when no SQL path exists", async () => {
    const base = {
      embedding: { modelId: () => "e", embed: async () => { const error = new Error("down"); error.code = "PROVIDER_NETWORK_ERROR"; throw error; } },
      qdrant: { search: async () => [], ensureCollection: async () => {}, upsert: async () => {}, health: async () => ({ ok: true }) },
      reranker: { modelId: () => "r", rerank: async () => [] }, vectorVersion: "v",
    };
    const degraded = await new LocalVectorPipeline({
      ...base,
      source: { loadProjectDescription: async () => null, rehydrate: async () => [], readCreators: async () => ({ status: "available", platform: "douyin", rows: [creator()] }) },
    }).search({ queryText: "露营", platform: "douyin" });
    assert.equal(degraded.retrieval_mode, "sql-only");
    assert.equal(degraded.degraded_reason, "embedding_unavailable");
    assert.equal(degraded.matches[0].provenance.commercial_vector_available, false);

    const failed = await new LocalVectorPipeline({
      ...base,
      source: { loadProjectDescription: async () => null, rehydrate: async () => [], readCreators: async () => ({ status: "unavailable", platform: "xiaohongshu", rows: [], reason: "source_not_configured" }) },
    }).search({ queryText: "露营", platform: "xiaohongshu" });
    assert.deepEqual(failed.error, { code: "VECTOR_DEPENDENCY_ERROR", dependency: "embedding_unavailable", source_status: "source_not_configured" });
  });
});
