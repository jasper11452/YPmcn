import { createRequire } from "node:module";
import type { QdrantClientLike } from "./qdrant.js";

const require = createRequire(import.meta.url);

export type NamedVectorName = "content" | "commercial";

export interface DerivedVectorPayload {
  platform: "dy" | "xhs";
  kw_uid: string;
  source_table: string;
  source_row_id: string;
  source_snapshot_date: string;
  source_updated_at: string;
  embedding_model_id: string;
  vector_version: string;
}

export interface NamedVectorPoint {
  id: string;
  vector: Record<NamedVectorName, number[]>;
  payload: DerivedVectorPayload;
}

export interface NamedVectorHit {
  id: string;
  score: number;
  payload: DerivedVectorPayload;
}

export interface QdrantSdkLike {
  collectionExists(collectionName: string): Promise<{ exists: boolean }>;
  createCollection(collectionName: string, options: {
    vectors: Record<NamedVectorName, { size: number; distance: "Cosine" }>;
  }): Promise<unknown>;
  getCollection(collectionName: string): Promise<unknown>;
  upsert(collectionName: string, options: { wait: true; points: NamedVectorPoint[] }): Promise<unknown>;
  query(collectionName: string, options: Record<string, unknown>): Promise<unknown>;
  getCollections(): Promise<unknown>;
  deleteCollection(collectionName: string): Promise<unknown>;
}

export interface RealQdrantConfig {
  url: string;
  collectionName: string;
  vectorSize: number;
  apiKey?: string;
  timeoutMs?: number;
  client?: QdrantSdkLike;
}

export class QdrantRequestError extends Error {
  readonly code = "QDRANT_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "QdrantRequestError";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function vectorSchema(vectorSize: number) {
  return {
    content: { size: vectorSize, distance: "Cosine" as const },
    commercial: { size: vectorSize, distance: "Cosine" as const },
  };
}

function validateVector(vector: number[], vectorSize: number, label: string): void {
  if (vector.length !== vectorSize || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`${label} vector must contain exactly ${vectorSize} finite values`);
  }
}

function namedVectorsFromCollection(info: unknown): Record<string, unknown> | undefined {
  const vectors = (info as { config?: { params?: { vectors?: unknown } } })?.config?.params?.vectors;
  return vectors && typeof vectors === "object" && !Array.isArray(vectors)
    ? vectors as Record<string, unknown>
    : undefined;
}

function validateExistingSchema(info: unknown, vectorSize: number): void {
  const vectors = namedVectorsFromCollection(info);
  for (const name of ["content", "commercial"] as const) {
    const vector = vectors?.[name] as { size?: unknown; distance?: unknown } | undefined;
    if (vector?.size !== vectorSize || vector?.distance !== "Cosine") {
      throw new QdrantRequestError(`Qdrant collection schema mismatch for named vector ${name}`);
    }
  }
}

function validateHit(hit: unknown): NamedVectorHit {
  const candidate = hit as { id?: unknown; score?: unknown; payload?: unknown };
  const payload = candidate?.payload as Partial<DerivedVectorPayload> | undefined;
  if (
    (typeof candidate?.id !== "string" && typeof candidate?.id !== "number") ||
    !Number.isFinite(candidate?.score) ||
    !payload ||
    (payload.platform !== "dy" && payload.platform !== "xhs") ||
    typeof payload.kw_uid !== "string"
  ) {
    throw new QdrantRequestError("Qdrant query response is invalid");
  }
  return {
    id: String(candidate.id),
    score: candidate.score as number,
    payload: payload as DerivedVectorPayload,
  };
}

export class RealQdrantClient implements QdrantClientLike<NamedVectorPoint> {
  private readonly collectionName: string;
  private readonly vectorSize: number;
  private readonly client: QdrantSdkLike;

  constructor(config: RealQdrantConfig) {
    if (!config.url?.trim()) throw new TypeError("Qdrant URL is required");
    if (!config.collectionName?.trim()) throw new TypeError("Qdrant collection is required");
    this.vectorSize = positiveInteger(config.vectorSize, "vectorSize");
    const timeout = positiveInteger(config.timeoutMs ?? 15_000, "timeoutMs");
    this.collectionName = config.collectionName;
    if (config.client) {
      this.client = config.client;
    } else {
      const { QdrantClient } = require("@qdrant/js-client-rest") as {
        QdrantClient: new (options: Record<string, unknown>) => QdrantSdkLike;
      };
      this.client = new QdrantClient({
        url: config.url,
        apiKey: config.apiKey,
        timeout,
        checkCompatibility: false,
      });
    }
  }

  private async sdkCall<T>(operation: () => Promise<T>, message: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QdrantRequestError || error instanceof TypeError) throw error;
      throw new QdrantRequestError(message, { cause: error });
    }
  }

  async ensureCollection(): Promise<void> {
    const exists = await this.sdkCall(
      () => this.client.collectionExists(this.collectionName),
      "Qdrant collection existence check failed",
    );
    if (!exists.exists) {
      await this.sdkCall(
        () => this.client.createCollection(this.collectionName, { vectors: vectorSchema(this.vectorSize) }),
        "Qdrant collection creation failed",
      );
      return;
    }
    const info = await this.sdkCall(
      () => this.client.getCollection(this.collectionName),
      "Qdrant collection inspection failed",
    );
    validateExistingSchema(info, this.vectorSize);
  }

  async upsert(points: NamedVectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    for (const point of points) {
      validateVector(point.vector.content, this.vectorSize, "content");
      validateVector(point.vector.commercial, this.vectorSize, "commercial");
    }
    await this.sdkCall(
      () => this.client.upsert(this.collectionName, { wait: true, points }),
      "Qdrant upsert failed",
    );
  }

  async search(name: NamedVectorName, vector: number[], limit: number, platform?: "dy" | "xhs"): Promise<NamedVectorHit[]> {
    validateVector(vector, this.vectorSize, name);
    positiveInteger(limit, "limit");
    const result = await this.sdkCall(
      () => this.client.query(this.collectionName, {
        query: vector,
        using: name,
        limit,
        with_payload: true,
        with_vector: false,
        ...(platform ? { filter: { must: [{ key: "platform", match: { value: platform } }] } } : {}),
      }),
      "Qdrant named-vector query failed",
    );
    const points = (result as { points?: unknown })?.points;
    if (!Array.isArray(points)) throw new QdrantRequestError("Qdrant query response is invalid");
    return points.map(validateHit);
  }

  async health(): Promise<{ ok: true }> {
    await this.sdkCall(() => this.client.getCollections(), "Qdrant health check failed");
    return { ok: true };
  }

  async deleteCollection(): Promise<void> {
    await this.sdkCall(
      () => this.client.deleteCollection(this.collectionName),
      "Qdrant collection deletion failed",
    );
  }
}
