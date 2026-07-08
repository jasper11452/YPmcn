/**
 * Sync pipeline: converts source rows into Qdrant vector points.
 *
 * No real MySQL client — CreatorSourceRow represents a fake row.
 * Later todos wire real MySQL queries that produce these rows.
 */
import type { EmbeddingProvider } from "../config/providers.js";
import type { QdrantClientLike, QdrantCollectionSchema, VectorPoint } from "./qdrant.js";
/**
 * Represents a creator row from MySQL source tables.
 * `content_tags` and `grow_tags` are `unknown` because they come from JSON
 * columns that may be arrays, JSON strings, or null.
 */
export interface CreatorSourceRow {
    platform: "xhs" | "dy";
    platform_account_id: string;
    source_table: string;
    content_tags: unknown;
    grow_tags: unknown;
    source_updated_at: string;
    display_name?: string;
    profile_url?: string;
}
export type SyncResult = {
    success: true;
    upserted: number;
    pointIds: string[];
} | {
    success: false;
    error: {
        code: "QDRANT_UNAVAILABLE" | "NO_TAGS_TO_SYNC";
        message: string;
    };
};
/**
 * Convert source rows into vector points.
 * Creates separate points for content tags and grow tags when each is non-empty.
 */
export declare function buildVectorPoints(rows: CreatorSourceRow[], embeddingProvider: EmbeddingProvider, vectorVersion: string): Promise<VectorPoint[]>;
/**
 * Sync creator tag vectors to Qdrant.
 * Ensures collection exists, builds points, upserts them.
 * Returns a SyncResult indicating success or failure.
 */
export declare function syncCreatorTagVectors(rows: CreatorSourceRow[], qdrant: QdrantClientLike, embeddingProvider: EmbeddingProvider, schema: QdrantCollectionSchema, vectorVersion: string): Promise<SyncResult>;
