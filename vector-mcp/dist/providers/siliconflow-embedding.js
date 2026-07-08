export function createSiliconFlowEmbeddingProvider(config) {
    return {
        modelId() { return config.model ?? "Qwen/Qwen3-Embedding-8B"; },
        async embed(_texts) {
            throw new Error("SiliconFlowEmbeddingProvider.embed() not implemented in stub");
        },
    };
}
