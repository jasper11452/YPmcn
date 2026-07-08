// @ts-nocheck
import { ConfigError } from "./errors.js";
function hashToFloat(text, seed) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) % 100000) / 100000;
}
export function createFakeEmbeddingProvider(dim) {
    return {
        modelId() { return `fake-embedding-${dim}`; },
        async embed(texts) {
            return texts.map((text) => {
                const vec = new Float32Array(dim);
                let norm = 0;
                for (let d = 0; d < dim; d++) {
                    const v = hashToFloat(text, d) * 2 - 1;
                    vec[d] = v;
                    norm += v * v;
                }
                const magnitude = Math.sqrt(norm) || 1;
                for (let d = 0; d < dim; d++)
                    vec[d] /= magnitude;
                return vec;
            });
        },
    };
}
function tokenize(text) {
    const tokens = new Set();
    const words = text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
    for (const w of words)
        tokens.add(w);
    for (const ch of text) {
        if (ch.trim().length > 0)
            tokens.add(ch);
    }
    return tokens;
}
export function createFakeRerankProvider() {
    return {
        modelId() { return "fake-rerank"; },
        async rerank(query, docs, topN) {
            const queryTokens = tokenize(query);
            const scored = docs.map((doc, index) => {
                const docTokens = tokenize(doc);
                let overlap = 0;
                for (const t of queryTokens) {
                    if (docTokens.has(t))
                        overlap++;
                }
                const score = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
                return { index, score };
            });
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, topN);
        },
    };
}
export function createBailianEmbeddingProvider(cfg) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_API_KEY"]);
    if (!cfg.baseUrl || cfg.baseUrl.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_BASE_URL"]);
    if (!cfg.model || cfg.model.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_EMBEDDING_MODEL"]);
    return {
        modelId() { return cfg.model; },
        async embed(_texts) {
            throw new Error("BailianEmbeddingProvider.embed() is not yet implemented");
        },
    };
}
export function createBailianRerankProvider(cfg) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_API_KEY"]);
    if (!cfg.baseUrl || cfg.baseUrl.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_BASE_URL"]);
    if (!cfg.model || cfg.model.trim() === "")
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_RERANK_MODEL"]);
    return {
        modelId() { return cfg.model; },
        async rerank(_query, _docs, _topN) {
            throw new Error("BailianRerankProvider.rerank() is not yet implemented");
        },
    };
}
