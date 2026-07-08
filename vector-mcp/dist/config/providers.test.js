import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeEmbeddingProvider, createFakeRerankProvider, createBailianEmbeddingProvider, createBailianRerankProvider, } from "./providers.js";
import { loadConfigFromEnv } from "./env.js";
import { ConfigError } from "./errors.js";
describe("createFakeEmbeddingProvider", () => {
    it("returns vectors of correct dimension", async () => {
        const provider = createFakeEmbeddingProvider(8);
        const result = await provider.embed(["hello", "world"]);
        assert.equal(result.length, 2);
        assert.equal(result[0].length, 8);
        assert.equal(result[1].length, 8);
        assert.ok(result[0] instanceof Float32Array);
    });
    it("is deterministic — same input returns same output", async () => {
        const provider = createFakeEmbeddingProvider(16);
        const a = await provider.embed(["AI深度使用"]);
        const b = await provider.embed(["AI深度使用"]);
        assert.equal(a.length, b.length);
        for (let i = 0; i < a[0].length; i++) {
            assert.equal(a[0][i], b[0][i], `dimension ${i} should match`);
        }
    });
    it("different inputs produce different vectors", async () => {
        const provider = createFakeEmbeddingProvider(16);
        const [a] = await provider.embed(["hello"]);
        const [b] = await provider.embed(["world"]);
        let allSame = true;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                allSame = false;
                break;
            }
        }
        assert.equal(allSame, false, "different inputs should produce different vectors");
    });
    it("vectors are L2-normalized", async () => {
        const provider = createFakeEmbeddingProvider(32);
        const [vec] = await provider.embed(["normalize me"]);
        let sumSq = 0;
        for (let i = 0; i < vec.length; i++) {
            sumSq += vec[i] * vec[i];
        }
        assert.ok(Math.abs(sumSq - 1.0) < 0.001, `L2 norm should be ~1.0, got ${Math.sqrt(sumSq)}`);
    });
    it("reports correct modelId", () => {
        const provider = createFakeEmbeddingProvider(64);
        assert.equal(provider.modelId(), "fake-embedding-64");
    });
});
describe("createFakeRerankProvider", () => {
    it("ranks docs by token overlap with query", async () => {
        const provider = createFakeRerankProvider();
        const results = await provider.rerank("母婴亲子", ["母婴亲子账号", "剧情搞笑", "母婴"], 2);
        assert.equal(results.length, 2);
        // "母婴亲子账号" and "母婴" share more characters with "母婴亲子" than "剧情搞笑"
        const topIndices = results.map((r) => r.index);
        assert.ok(topIndices.includes(0), "母婴亲子账号 should be in top 2");
        assert.ok(topIndices.includes(2), "母婴 should be in top 2");
        // Verify they are the top 2 (in some order)
        assert.equal(results[0].index === 0 || results[0].index === 2, true);
        assert.equal(results[1].index === 0 || results[1].index === 2, true);
    });
    it("returns at most topN results", async () => {
        const provider = createFakeRerankProvider();
        const results = await provider.rerank("test", ["a", "b", "c", "d"], 2);
        assert.equal(results.length, 2);
    });
    it("scores are descending", async () => {
        const provider = createFakeRerankProvider();
        const results = await provider.rerank("母婴亲子", ["母婴亲子账号", "剧情搞笑", "母婴", "母婴亲子"], 4);
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i].score <= results[i - 1].score, "scores should be descending");
        }
    });
    it("reports correct modelId", () => {
        const provider = createFakeRerankProvider();
        assert.equal(provider.modelId(), "fake-rerank");
    });
});
describe("createBailianEmbeddingProvider (stub)", () => {
    it("throws BAILIAN_CONFIG_MISSING when apiKey is empty", () => {
        assert.throws(() => createBailianEmbeddingProvider({
            apiKey: "",
            baseUrl: "https://example.com",
            model: "test-model",
            dimension: 128,
        }), (err) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "BAILIAN_CONFIG_MISSING");
            assert.ok(err.missingVars.includes("BAILIAN_API_KEY"));
            return true;
        });
    });
    it("throws BAILIAN_CONFIG_MISSING when baseUrl is empty", () => {
        assert.throws(() => createBailianEmbeddingProvider({
            apiKey: "valid-key",
            baseUrl: "",
            model: "test-model",
            dimension: 128,
        }), (err) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "BAILIAN_CONFIG_MISSING");
            return true;
        });
    });
    it("creates provider when config is valid", () => {
        const provider = createBailianEmbeddingProvider({
            apiKey: "valid-key",
            baseUrl: "https://example.com",
            model: "test-model",
            dimension: 128,
        });
        assert.equal(provider.modelId(), "test-model");
    });
});
describe("createBailianRerankProvider (stub)", () => {
    it("throws BAILIAN_CONFIG_MISSING when apiKey is empty", () => {
        assert.throws(() => createBailianRerankProvider({
            apiKey: "",
            baseUrl: "https://example.com",
            model: "test-rerank",
        }), (err) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "BAILIAN_CONFIG_MISSING");
            return true;
        });
    });
});
describe("loadConfigFromEnv", () => {
    it("returns fake config when mode is unset", () => {
        const cfg = loadConfigFromEnv({});
        assert.equal(cfg.mode, "fake");
        assert.equal(cfg.mysql.host, "127.0.0.1");
        assert.equal(cfg.qdrant.vectorSize, 128);
        assert.equal(cfg.bailian.embedding.dimension, 128);
    });
    it("returns fake config when mode is 'fake'", () => {
        const cfg = loadConfigFromEnv({ VECTOR_MCP_MODE: "fake" });
        assert.equal(cfg.mode, "fake");
    });
    it("throws MYSQL_CONFIG_MISSING in real mode with no env vars", () => {
        assert.throws(() => loadConfigFromEnv({ VECTOR_MCP_MODE: "real" }), (err) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "MYSQL_CONFIG_MISSING");
            return true;
        });
    });
    it("throws QDRANT_CONFIG_MISSING when only mysql vars are set", () => {
        assert.throws(() => loadConfigFromEnv({
            VECTOR_MCP_MODE: "real",
            MYSQL_HOST: "localhost",
            MYSQL_PORT: "3306",
            MYSQL_USER: "root",
            MYSQL_PASSWORD: "pass",
            MYSQL_DATABASE: "test",
        }), (err) => {
            assert.ok(err instanceof ConfigError);
            assert.equal(err.code, "QDRANT_CONFIG_MISSING");
            return true;
        });
    });
    it("returns real config when all required vars are present", () => {
        const cfg = loadConfigFromEnv({
            VECTOR_MCP_MODE: "real",
            MYSQL_HOST: "db.example.com",
            MYSQL_PORT: "3307",
            MYSQL_USER: "app_user",
            MYSQL_PASSWORD: "secret",
            MYSQL_DATABASE: "vector_db",
            QDRANT_URL: "http://qdrant:6333",
            QDRANT_COLLECTION: "my_collection",
            QDRANT_VECTOR_SIZE: "256",
            QDRANT_DISTANCE: "Dot",
            BAILIAN_API_KEY: "sk-abc123",
            BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com",
            BAILIAN_EMBEDDING_MODEL: "text-embedding-v3",
            BAILIAN_EMBEDDING_DIM: "512",
            BAILIAN_RERANK_MODEL: "gte-rerank-hybrid",
        });
        assert.equal(cfg.mode, "real");
        assert.equal(cfg.mysql.host, "db.example.com");
        assert.equal(cfg.mysql.port, 3307);
        assert.equal(cfg.qdrant.distance, "Dot");
        assert.equal(cfg.qdrant.vectorSize, 256);
        assert.equal(cfg.bailian.embedding.model, "text-embedding-v3");
        assert.equal(cfg.bailian.embedding.dimension, 512);
        assert.equal(cfg.bailian.rerank.model, "gte-rerank-hybrid");
    });
});
