/**
 * Vector module barrel export.
 * Re-exports Qdrant schema types, fake client, and sync pipeline.
 */
export { buildCollectionSchema, FakeQdrantClient, } from "./qdrant.js";
export { buildVectorPoints, syncCreatorTagVectors, } from "./sync.js";
