/**
 * SiliconFlow Embedding provider using Qwen/Qwen3-Embedding-8B.
 *
 * API: POST https://api.siliconflow.cn/v1/embeddings
 * Docs: https://docs.siliconflow.cn/api-reference/embeddings
 */
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1/embeddings";
const DEFAULT_MODEL = "Qwen/Qwen3-Embedding-8B";
const BATCH_SIZE = 32;
export function createSiliconFlowEmbeddingProvider(config) {
    const apiKey = config.apiKey || process.env.SILICONFLOW_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
        throw new Error("SiliconFlow API key is required. Set SILICONFLOW_API_KEY env var or pass apiKey in config.");
    }
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const model = config.model ?? DEFAULT_MODEL;
    async function embedBatch(texts) {
        const response = await fetch(baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                input: texts,
                encoding_format: "float",
            }),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            throw new Error(`SiliconFlow Embedding API error: ${response.status} ${response.statusText} - ${errorText}`);
        }
        const result = (await response.json());
        if (!result.data || !Array.isArray(result.data)) {
            throw new Error(`SiliconFlow Embedding API returned invalid response: ${JSON.stringify(result).slice(0, 200)}`);
        }
        // Sort by index to maintain order
        const sorted = [...result.data].sort((a, b) => a.index - b.index);
        return sorted.map((item) => new Float32Array(item.embedding));
    }
    return {
        modelId() {
            return model;
        },
        async embed(texts) {
            if (texts.length === 0) {
                return [];
            }
            // Batch if > 32 items
            if (texts.length <= BATCH_SIZE) {
                return embedBatch(texts);
            }
            const results = [];
            for (let i = 0; i < texts.length; i += BATCH_SIZE) {
                const batch = texts.slice(i, i + BATCH_SIZE);
                const batchResults = await embedBatch(batch);
                results.push(...batchResults);
            }
            return results;
        },
    };
}
