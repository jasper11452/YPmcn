import type { BailianEmbeddingConfig, BailianRerankConfig } from "./types.js";
export interface EmbeddingProvider {
    embed(texts: string[]): Promise<Float32Array[]>;
    modelId(): string;
}
export interface RerankProvider {
    rerank(query: string, docs: string[], topN: number): Promise<Array<{
        index: number;
        score: number;
    }>>;
    modelId(): string;
}
export declare function createFakeEmbeddingProvider(dim: number): EmbeddingProvider;
export declare function createFakeRerankProvider(): RerankProvider;
export declare function createBailianEmbeddingProvider(cfg: BailianEmbeddingConfig): EmbeddingProvider;
export declare function createBailianRerankProvider(cfg: BailianRerankConfig): RerankProvider;
