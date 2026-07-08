// @ts-nocheck
export interface SiliconFlowRerankerConfig {
  apiKey: string;
  model?: string;
}

export function createSiliconFlowRerankerProvider(config: SiliconFlowRerankerConfig) {
  return {
    modelId() { return config.model ?? "BAAI/bge-reranker-v2-m3"; },
    async rerank(_query: string, _docs: string[], _topN: number): Promise<Array<{ index: number; score: number }>> {
      throw new Error("SiliconFlowRerankerProvider.rerank() not implemented in stub");
    },
  };
}
