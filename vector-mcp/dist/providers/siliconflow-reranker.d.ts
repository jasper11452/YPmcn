/**
 * SiliconFlow Reranker provider using Qwen/Qwen3-Reranker-8B.
 *
 * API: POST https://api.siliconflow.cn/v1/rerank
 * Docs: https://docs.siliconflow.cn/api-reference/rerank
 */
import type { RerankProvider } from "../config/providers.js";
export interface SiliconFlowRerankerConfig {
    apiKey: string;
    baseUrl?: string;
    model?: string;
}
export declare function createSiliconFlowRerankerProvider(config: SiliconFlowRerankerConfig): RerankProvider;
