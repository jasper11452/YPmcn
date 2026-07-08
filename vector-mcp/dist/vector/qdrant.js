export function buildCollectionSchema(config) {
    return {
        collectionName: config.collectionName,
        vectorSize: config.vectorSize,
        distance: config.distance,
        payloadIndexes: [
            "platform",
            "platform_account_id",
            "tag_type",
            "source_updated_at",
            "vector_version",
        ],
    };
}
function tokenize(text) {
    const tokens = [];
    const words = text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
    tokens.push(...words);
    for (const ch of text) {
        if (ch.trim().length > 0) {
            tokens.push(ch);
        }
    }
    return tokens;
}
function computeBM25Score(queryTokens, docTokens, idfMap, avgDocLen, k1, b) {
    const docLen = docTokens.length;
    let score = 0;
    const tfMap = new Map();
    for (const t of docTokens) {
        tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    }
    for (const qt of queryTokens) {
        const idf = idfMap.get(qt) ?? 0;
        if (idf === 0)
            continue;
        const tf = tfMap.get(qt) ?? 0;
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
        score += idf * (numerator / denominator);
    }
    return score;
}
export class FakeQdrantClient {
    schemas = [];
    points = [];
    unavailable;
    constructor(options) {
        this.unavailable = options?.unavailable ?? false;
    }
    assertAvailable() {
        if (this.unavailable) {
            const err = new Error("Qdrant is unavailable");
            err.code = "QDRANT_UNAVAILABLE";
            throw err;
        }
    }
    async ensureCollection(schema) {
        this.assertAvailable();
        this.schemas.push(schema);
    }
    async upsert(points) {
        this.assertAvailable();
        for (const point of points) {
            const existingIdx = this.points.findIndex((p) => p.id === point.id);
            if (existingIdx >= 0) {
                this.points[existingIdx] = point;
            }
            else {
                this.points.push(point);
            }
        }
    }
    async search(params) {
        this.assertAvailable();
        const threshold = params.score_threshold ?? 0;
        const results = this.points.map((point) => {
            let dot = 0;
            let normA = 0;
            let normB = 0;
            const dim = Math.min(params.vector.length, point.vector.length);
            for (let i = 0; i < dim; i++) {
                dot += params.vector[i] * point.vector[i];
                normA += params.vector[i] * params.vector[i];
                normB += point.vector[i] * point.vector[i];
            }
            const score = normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
            return { id: point.id, score, payload: point.payload };
        });
        results.sort((a, b) => b.score - a.score);
        const filtered = results.filter((r) => r.score >= threshold);
        return filtered.slice(0, params.limit);
    }
    bm25Search(params) {
        this.assertAvailable();
        const k1 = 1.2;
        const b = 0.75;
        const queryTokens = tokenize(params.query);
        const docs = this.points.map((point) => {
            const docText = [...point.payload.raw_tags, point.payload.normalized_text].join(" ");
            return {
                id: point.id,
                tokens: tokenize(docText),
                payload: point.payload,
            };
        });
        if (docs.length === 0)
            return [];
        const N = docs.length;
        const totalLen = docs.reduce((sum, d) => sum + d.tokens.length, 0);
        const avgDocLen = totalLen / N;
        const dfMap = new Map();
        for (const doc of docs) {
            const seen = new Set();
            for (const t of doc.tokens) {
                if (!seen.has(t)) {
                    seen.add(t);
                    dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
                }
            }
        }
        const idfMap = new Map();
        for (const [term, df] of dfMap) {
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
            idfMap.set(term, idf);
        }
        const results = docs.map((doc) => ({
            id: doc.id,
            score: computeBM25Score(queryTokens, doc.tokens, idfMap, avgDocLen, k1, b),
            payload: doc.payload,
        }));
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, params.limit);
    }
}
