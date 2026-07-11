import {
  ProviderRequestError,
  positiveInteger,
  requestJsonWithRetry,
  type SiliconFlowRequestConfig,
} from "./siliconflow-embedding.js";

export interface SiliconFlowRerankerConfig extends SiliconFlowRequestConfig {
  model?: string;
  batchSize?: number;
}

export function createSiliconFlowRerankerProvider(config: SiliconFlowRerankerConfig) {
  const baseUrl = config.baseUrl ?? "https://api.siliconflow.cn/v1";
  const model = config.model ?? "BAAI/bge-reranker-v2-m3";
  const batchSize = positiveInteger(config.batchSize, 50, "batchSize");
  return {
    modelId() { return model; },
    async rerank(
      query: string,
      docs: string[],
      topN: number,
    ): Promise<Array<{ index: number; score: number }>> {
      if (docs.length === 0) return [];
      const merged: Array<{ index: number; score: number }> = [];
      for (let start = 0; start < docs.length; start += batchSize) {
        const batch = docs.slice(start, start + batchSize);
        const json = await requestJsonWithRetry<{
          results: Array<{ index: number; relevance_score: number }>;
        }>(`${baseUrl}/rerank`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, query, documents: batch, top_n: batch.length }),
        }, config);
        if (!Array.isArray(json.results)) {
          throw new ProviderRequestError(
            "PROVIDER_RESPONSE_INVALID",
            "SiliconFlow rerank response is missing results",
            { retryable: false },
          );
        }
        for (const entry of json.results) {
          if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= batch.length) {
            throw new ProviderRequestError(
              "PROVIDER_RESPONSE_INVALID",
              "SiliconFlow rerank response contains an invalid index",
              { retryable: false },
            );
          }
          merged.push({ index: start + entry.index, score: entry.relevance_score });
        }
      }
      merged.sort((left, right) => right.score - left.score);
      return merged.slice(0, topN);
    },
  };
}
