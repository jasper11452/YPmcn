/**
 * SiliconFlow Reranker provider using Qwen/Qwen3-Reranker-8B.
 *
 * API: POST https://api.siliconflow.cn/v1/rerank
 * Docs: https://docs.siliconflow.cn/api-reference/rerank
 */
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1/rerank";
const DEFAULT_MODEL = "Qwen/Qwen3-Reranker-8B";
export function createSiliconFlowRerankerProvider(config) {
    const apiKey = config.apiKey || process.env.SILICONFLOW_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
        throw new Error("SiliconFlow API key is required. Set SILICONFLOW_API_KEY env var or pass apiKey in config.");
    }
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const model = config.model ?? DEFAULT_MODEL;
    return {
        modelId() {
            return model;
        },
        async rerank(query, docs, topN) {
            if (docs.length === 0) {
                return [];
            }
            const response = await fetch(baseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    query,
                    documents: docs,
                    top_n: topN,
                }),
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => "Unknown error");
                throw new Error(`SiliconFlow Rerank API error: ${response.status} ${response.statusText} - ${errorText}`);
            }
            const result = (await response.json());
            if (!result.results || !Array.isArray(result.results)) {
                throw new Error(`SiliconFlow Rerank API returned invalid response: ${JSON.stringify(result).slice(0, 200)}`);
            }
            // Map to our interface: relevance_score -> score
            return result.results
                .map((r) => ({ index: r.index, score: r.relevance_score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, topN);
        },
    };
}
