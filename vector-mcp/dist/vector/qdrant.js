/**
 * Qdrant collection schema types and fake client for the vector MCP layer.
 *
 * No real Qdrant network client — this module defines interfaces and an
 * in-memory fake so later todos can wire a real Qdrant instance.
 */
/**
 * Build a QdrantCollectionSchema from a QdrantConfig.
 * Payload indexes cover identity fields needed for filtered search.
 */
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
/**
 * In-memory fake Qdrant client for testing.
 * Stores ensured schemas and upserted points.
 * Can simulate unavailability via `{ unavailable: true }`.
 */
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
        // Upsert semantics: replace points with same id, append new ones
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
}
