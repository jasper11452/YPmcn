export function createSiliconFlowRerankerProvider(config) {
    return {
        modelId() { return config.model ?? "BAAI/bge-reranker-v2-m3"; },
        async rerank(_query, _docs, _topN) {
            throw new Error("SiliconFlowRerankerProvider.rerank() not implemented in stub");
        },
    };
}
