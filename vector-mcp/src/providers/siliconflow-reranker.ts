// @ts-nocheck
export interface SiliconFlowRerankerConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export function createSiliconFlowRerankerProvider(config: SiliconFlowRerankerConfig) {
  const BASE_URL = config.baseUrl ?? "https://api.siliconflow.cn/v1";
  const MODEL = config.model ?? "BAAI/bge-reranker-v2-m3";
  return {
    modelId() { return MODEL; },
    async rerank(query: string, docs: string[], topN: number): Promise<Array<{ index: number; score: number }>> {
      if (docs.length === 0) return [];
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
      const json = await resp.json() as { results: Array<{ index: number; relevance_score: number }> };
      return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
    },
  };
}
