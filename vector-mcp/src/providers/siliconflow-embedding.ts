// @ts-nocheck
export interface SiliconFlowEmbeddingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export function createSiliconFlowEmbeddingProvider(config: SiliconFlowEmbeddingConfig) {
  const BASE_URL = config.baseUrl ?? "https://api.siliconflow.cn/v1";
  const MODEL = config.model ?? "Qwen/Qwen3-Embedding-8B";
  return {
    modelId() { return MODEL; },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const resp = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          input: texts,
          encoding_format: "float",
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        throw new Error(`SiliconFlow embedding error ${resp.status}: ${errBody}`);
      }
      const json = await resp.json() as { data: Array<{ embedding: number[]; index: number }> };
      // Sort by index to preserve input order
      json.data.sort((a, b) => a.index - b.index);
      return json.data.map((d) => new Float32Array(d.embedding));
    },
  };
}
