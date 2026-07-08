import { ConfigError } from "./errors.js";
function fakeConfig() {
    return {
        mode: "fake",
        mysql: {
            host: "127.0.0.1",
            port: 3306,
            user: "fake_user",
            password: "fake_password",
            database: "vector_mcp_fake",
            ssl: false,
            connectionLimit: 5,
        },
        qdrant: {
            url: "http://127.0.0.1:6333",
            apiKey: "fake_qdrant_key",
            collectionName: "fake_collection",
            vectorSize: 128,
            distance: "Cosine",
        },
        bailian: {
            embedding: {
                apiKey: "fake_bailian_key",
                baseUrl: "https://dashscope.aliyuncs.com/api/v1",
                model: "text-embedding-v3-fake",
                dimension: 128,
                batchSize: 25,
            },
            rerank: {
                apiKey: "fake_bailian_key",
                baseUrl: "https://dashscope.aliyuncs.com/api/v1",
                model: "gte-rerank-hybrid-fake",
                topN: 10,
            },
        },
    };
}
export function loadConfigFromEnv(env) {
    const e = env ?? process.env;
    const mode = (e["VECTOR_MCP_MODE"] ?? "fake").trim();
    if (mode !== "real") {
        return fakeConfig();
    }
    // Real mode — validate all required vars, fail closed with grouped error codes.
    const errors = [];
    // MySQL
    const mysqlVars = ["MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"];
    const mysqlMissing = mysqlVars.filter((v) => !e[v] || e[v].trim() === "");
    if (mysqlMissing.length > 0) {
        errors.push({ code: "MYSQL_CONFIG_MISSING", vars: mysqlMissing });
    }
    // Qdrant
    const qdrantVars = ["QDRANT_URL", "QDRANT_COLLECTION", "QDRANT_VECTOR_SIZE"];
    const qdrantMissing = qdrantVars.filter((v) => !e[v] || e[v].trim() === "");
    if (qdrantMissing.length > 0) {
        errors.push({ code: "QDRANT_CONFIG_MISSING", vars: qdrantMissing });
    }
    // Bailian
    const bailianVars = [
        "BAILIAN_API_KEY",
        "BAILIAN_BASE_URL",
        "BAILIAN_EMBEDDING_MODEL",
        "BAILIAN_EMBEDDING_DIM",
        "BAILIAN_RERANK_MODEL",
    ];
    const bailianMissing = bailianVars.filter((v) => !e[v] || e[v].trim() === "");
    if (bailianMissing.length > 0) {
        errors.push({ code: "BAILIAN_CONFIG_MISSING", vars: bailianMissing });
    }
    if (errors.length > 0) {
        // Throw the first grouped error. Callers can extend to aggregate if needed.
        const first = errors[0];
        throw new ConfigError(first.code, first.vars);
    }
    const distance = (e["QDRANT_DISTANCE"] ?? "Cosine").trim();
    if (distance !== "Cosine" && distance !== "Dot" && distance !== "Euclid") {
        throw new ConfigError("QDRANT_CONFIG_MISSING", ["QDRANT_DISTANCE (must be Cosine|Dot|Euclid)"]);
    }
    return {
        mode: "real",
        mysql: {
            host: e["MYSQL_HOST"].trim(),
            port: parseInt(e["MYSQL_PORT"].trim(), 10),
            user: e["MYSQL_USER"].trim(),
            password: e["MYSQL_PASSWORD"].trim(),
            database: e["MYSQL_DATABASE"].trim(),
            ssl: e["MYSQL_SSL"]?.trim() === "true",
            connectionLimit: e["MYSQL_CONNECTION_LIMIT"] ? parseInt(e["MYSQL_CONNECTION_LIMIT"].trim(), 10) : undefined,
        },
        qdrant: {
            url: e["QDRANT_URL"].trim(),
            apiKey: e["QDRANT_API_KEY"]?.trim() || undefined,
            collectionName: e["QDRANT_COLLECTION"].trim(),
            vectorSize: parseInt(e["QDRANT_VECTOR_SIZE"].trim(), 10),
            distance,
        },
        bailian: {
            embedding: {
                apiKey: e["BAILIAN_API_KEY"].trim(),
                baseUrl: e["BAILIAN_BASE_URL"].trim(),
                model: e["BAILIAN_EMBEDDING_MODEL"].trim(),
                dimension: parseInt(e["BAILIAN_EMBEDDING_DIM"].trim(), 10),
                batchSize: e["BAILIAN_EMBEDDING_BATCH_SIZE"] ? parseInt(e["BAILIAN_EMBEDDING_BATCH_SIZE"].trim(), 10) : undefined,
            },
            rerank: {
                apiKey: e["BAILIAN_API_KEY"].trim(),
                baseUrl: e["BAILIAN_BASE_URL"].trim(),
                model: e["BAILIAN_RERANK_MODEL"].trim(),
                topN: e["BAILIAN_RERANK_TOP_N"] ? parseInt(e["BAILIAN_RERANK_TOP_N"].trim(), 10) : undefined,
            },
        },
    };
}
/**
 * Redact secrets for safe logging. Replaces password/apiKey with "***".
 */
export function redactConfig(cfg) {
    return {
        ...cfg,
        mysql: { ...cfg.mysql, password: "***" },
        qdrant: { ...cfg.qdrant, apiKey: cfg.qdrant.apiKey ? "***" : undefined },
        bailian: {
            embedding: { ...cfg.bailian.embedding, apiKey: "***" },
            rerank: { ...cfg.bailian.rerank, apiKey: "***" },
        },
    };
}
