import { ConfigError } from "./errors.js";
// ─── Deterministic hash for fake embedding ────────────────────────────────────
/**
 * Simple deterministic hash: FNV-1a variant over UTF-16 code units.
 * Returns a stable float in [0, 1) for a given seed index.
 */
function hashToFloat(text, seed) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Normalize to [0, 1)
    return ((h >>> 0) % 100000) / 100000;
}
// ─── Fake providers ───────────────────────────────────────────────────────────
export function createFakeEmbeddingProvider(dim) {
    return {
        modelId() {
            return `fake-embedding-${dim}`;
        },
        async embed(texts) {
            return texts.map((text) => {
                const vec = new Float32Array(dim);
                let norm = 0;
                for (let d = 0; d < dim; d++) {
                    const v = hashToFloat(text, d) * 2 - 1; // range [-1, 1]
                    vec[d] = v;
                    norm += v * v;
                }
                // L2-normalize so cosine similarity is meaningful
                const magnitude = Math.sqrt(norm) || 1;
                for (let d = 0; d < dim; d++) {
                    vec[d] /= magnitude;
                }
                return vec;
            });
        },
    };
}
/**
 * Tokenize by splitting on non-word characters (Unicode-aware).
 * For Chinese text, each character becomes a token.
 */
function tokenize(text) {
    const tokens = new Set();
    // Split on whitespace/punctuation, then add individual CJK chars
    const words = text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
    for (const w of words) {
        tokens.add(w);
    }
    // Also add individual characters for CJK overlap detection
    for (const ch of text) {
        if (ch.trim().length > 0) {
            tokens.add(ch);
        }
    }
    return tokens;
}
export function createFakeRerankProvider() {
    return {
        modelId() {
            return "fake-rerank";
        },
        async rerank(query, docs, topN) {
            const queryTokens = tokenize(query);
            const scored = docs.map((doc, index) => {
                const docTokens = tokenize(doc);
                let overlap = 0;
                for (const t of queryTokens) {
                    if (docTokens.has(t))
                        overlap++;
                }
                // Score = overlap ratio relative to query token count
                const score = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
                return { index, score };
            });
            // Sort descending by score
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, topN);
        },
    };
}
// ─── Bailian stubs (config-validated, no network calls) ───────────────────────
export function createBailianEmbeddingProvider(cfg) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_API_KEY"]);
    }
    if (!cfg.baseUrl || cfg.baseUrl.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_BASE_URL"]);
    }
    if (!cfg.model || cfg.model.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_EMBEDDING_MODEL"]);
    }
    return {
        modelId() {
            return cfg.model;
        },
        async embed(_texts) {
            // STUB: real implementation will call Bailian embedding API.
            throw new Error("BailianEmbeddingProvider.embed() is not yet implemented — fill in real config and connect HTTP client.");
        },
    };
}
export function createBailianRerankProvider(cfg) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_API_KEY"]);
    }
    if (!cfg.baseUrl || cfg.baseUrl.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_BASE_URL"]);
    }
    if (!cfg.model || cfg.model.trim() === "") {
        throw new ConfigError("BAILIAN_CONFIG_MISSING", ["BAILIAN_RERANK_MODEL"]);
    }
    return {
        modelId() {
            return cfg.model;
        },
        async rerank(_query, _docs, _topN) {
            // STUB: real implementation will call Bailian rerank API.
            throw new Error("BailianRerankProvider.rerank() is not yet implemented — fill in real config and connect HTTP client.");
        },
    };
}
