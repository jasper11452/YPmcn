/**
 * Vector module barrel export.
 * Re-exports Qdrant schema types, fake client, and sync pipeline.
 */
export { buildCollectionSchema, FakeQdrantClient, type QdrantClientLike, type QdrantCollectionSchema, type QdrantDistance, type VectorPoint, type VectorPointPayload, } from "./qdrant.js";
export { buildVectorPoints, syncCreatorTagVectors, type CreatorSourceRow, type SyncResult, } from "./sync.js";
