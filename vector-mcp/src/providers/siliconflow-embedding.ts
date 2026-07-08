// @ts-nocheck
export interface SiliconFlowEmbeddingConfig {
  apiKey: string;
  model?: string;
}

export function createSiliconFlowEmbeddingProvider(config: SiliconFlowEmbeddingConfig) {
  return {
    modelId() { return config.model ?? "Qwen/Qwen3-Embedding-8B"; },
    async embed(_texts: string[]): Promise<Float32Array[]> {
      throw new Error("SiliconFlowEmbeddingProvider.embed() not implemented in stub");
    },
  };
}
