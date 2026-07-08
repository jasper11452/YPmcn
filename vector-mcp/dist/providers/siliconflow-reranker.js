export function createSiliconFlowRerankerProvider(config) {
    const BASE_URL = config.baseUrl ?? "https://api.siliconflow.cn/v1";
    const MODEL = config.model ?? "BAAI/bge-reranker-v2-m3";
    return {
        modelId() { return MODEL; },
        async rerank(query, docs, topN) {
            if (docs.length === 0)
                return [];
            const resp = await fetch(`${BASE_URL}/rerank`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${config.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: MODEL,
                    query,
                    documents: docs,
                    top_n: topN,
                }),
            });
            if (!resp.ok) {
                const errBody = await resp.text().catch(() => "");
                throw new Error(`SiliconFlow rerank error ${resp.status}: ${errBody}`);
            }
            const json = await resp.json();
            return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
        },
    };
}
