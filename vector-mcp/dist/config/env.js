export function loadConfigFromEnv(env) {
    const e = env ?? process.env;
    return {
        mysql: {
            host: e.MYSQL_HOST ?? "localhost",
            port: Number(e.MYSQL_PORT) || 3306,
            user: e.MYSQL_USER ?? "root",
            password: e.MYSQL_PASSWORD ?? "",
            database: e.MYSQL_DATABASE ?? "test",
        },
        qdrant: {
            url: e.QDRANT_URL ?? "http://localhost:6333",
            collectionName: e.QDRANT_COLLECTION ?? "creator_tags",
            vectorSize: Number(e.QDRANT_VECTOR_SIZE) || 128,
            distance: "Cosine",
        },
        bailian: {
            embedding: {
                apiKey: e.BAILIAN_API_KEY ?? "",
                baseUrl: e.BAILIAN_BASE_URL ?? "",
                model: e.BAILIAN_EMBEDDING_MODEL ?? "",
                dimension: Number(e.BAILIAN_EMBEDDING_DIM) || 1024,
            },
            rerank: {
                apiKey: e.BAILIAN_API_KEY ?? "",
                baseUrl: e.BAILIAN_BASE_URL ?? "",
                model: e.BAILIAN_RERANK_MODEL ?? "",
            },
        },
        mode: "fake",
    };
}
export function redactConfig(cfg) {
    return {
        ...cfg,
        mysql: { ...cfg.mysql, password: "***" },
        bailian: {
            embedding: { ...cfg.bailian.embedding, apiKey: "***" },
            rerank: { ...cfg.bailian.rerank, apiKey: "***" },
        },
    };
}
