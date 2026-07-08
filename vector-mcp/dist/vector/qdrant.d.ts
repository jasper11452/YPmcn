/**
 * Qdrant collection schema types and fake client for the vector MCP layer.
 *
 * No real Qdrant network client — this module defines interfaces and an
 * in-memory fake so later todos can wire a real Qdrant instance.
 */
import type { QdrantConfig } from "../config/types.js";
export type QdrantDistance = "Cosine" | "Dot" | "Euclid";
/**
 * Payload attached to every vector point.
 * Identity fields are mandatory so search results can identify the creator
 * and explain which tag type matched.
 */
export interface VectorPointPayload {
    /** "xhs" or "dy" */
    platform: string;
    /** Native creator ID on the platform */
    platform_account_id: string;
    /** Logical source-table identifier (e.g. "xhs_creator") */
    source_table: string;
    /** "content" or "grow" — which tag set produced this point */
    tag_type: string;
    /** Original tag array as-is (serialized) */
    raw_tags: string[];
    /** Deterministic text that was embedded */
    normalized_text: string;
    /** ISO-8601 timestamp from the source row */
    source_updated_at: string;
    /** Embedding model identifier (e.g. "fake-embedding-128") */
    embedding_model_id: string;
    /** Version tag for the vector representation */
    vector_version: string;
}
export interface VectorPoint {
    id: string;
    vector: number[];
    payload: VectorPointPayload;
}
export interface QdrantCollectionSchema {
    collectionName: string;
    vectorSize: number;
    distance: QdrantDistance;
    /** Fields that should have payload indexes for filtered search */
    payloadIndexes: string[];
}
/**
 * Build a QdrantCollectionSchema from a QdrantConfig.
 * Payload indexes cover identity fields needed for filtered search.
 */
export declare function buildCollectionSchema(config: QdrantConfig): QdrantCollectionSchema;
export interface QdrantClientLike {
    ensureCollection(schema: QdrantCollectionSchema): Promise<void>;
    upsert(points: VectorPoint[]): Promise<void>;
    search?(params: {
        vector: number[];
        limit: number;
        filter?: Record<string, unknown>;
        score_threshold?: number;
    }): Promise<unknown>;
}
export interface FakeQdrantClientOptions {
    /** When true, all operations throw with code QDRANT_UNAVAILABLE */
    unavailable?: boolean;
}
/**
 * In-memory fake Qdrant client for testing.
 * Stores ensured schemas and upserted points.
 * Can simulate unavailability via `{ unavailable: true }`.
 */
export declare class FakeQdrantClient implements QdrantClientLike {
    readonly schemas: QdrantCollectionSchema[];
    readonly points: VectorPoint[];
    private readonly unavailable;
    constructor(options?: FakeQdrantClientOptions);
    private assertAvailable;
    ensureCollection(schema: QdrantCollectionSchema): Promise<void>;
    upsert(points: VectorPoint[]): Promise<void>;
    search(params: {
        vector: number[];
        limit: number;
        filter?: Record<string, unknown>;
        score_threshold?: number;
    }): Promise<Array<{
        id: string;
        score: number;
        payload: VectorPointPayload;
    }>>;
}
