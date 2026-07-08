/**
 * SiliconFlow Embedding provider using Qwen/Qwen3-Embedding-8B.
 *
 * API: POST https://api.siliconflow.cn/v1/embeddings
 * Docs: https://docs.siliconflow.cn/api-reference/embeddings
 */
import type { EmbeddingProvider } from "../config/providers.js";
export interface SiliconFlowEmbeddingConfig {
    apiKey: string;
    baseUrl?: string;
    model?: string;
}
export declare function createSiliconFlowEmbeddingProvider(config: SiliconFlowEmbeddingConfig): EmbeddingProvider;
