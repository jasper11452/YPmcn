import type { QdrantConfig } from "../config/types.js";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type QdrantDistance = "Cosine" | "Dot" | "Euclid";

export interface VectorPointPayload {
  platform: string;
  platform_account_id: string;
  source_table: string;
  tag_type: string;
  raw_tags: string[];
  normalized_text: string;
  source_updated_at: string;
  embedding_model_id: string;
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
  payloadIndexes: string[];
}

export function buildCollectionSchema(config: QdrantConfig): QdrantCollectionSchema {
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

export interface QdrantClientLike<TPoint = VectorPoint> {
  ensureCollection(schema?: QdrantCollectionSchema): Promise<void>;
  upsert(points: TPoint[]): Promise<void>;
}

export interface FakeQdrantClientOptions {
  unavailable?: boolean;
  fileSystem?: PersistenceFileSystem;
}

export interface PersistenceFileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  writeFileSync(path: string, data: string, encoding: "utf8"): unknown;
  renameSync(oldPath: string, newPath: string): unknown;
  rmSync(path: string, options: { force: true }): unknown;
}

const defaultFileSystem: PersistenceFileSystem = {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
};

export class PersistenceCorruptionError extends Error {
  readonly code = "PERSISTENCE_CORRUPT";
  readonly filePath: string;

  constructor(filePath: string, cause?: unknown) {
    super(`Vector persistence snapshot is corrupt: ${filePath}`, { cause });
    this.name = "PersistenceCorruptionError";
    this.filePath = filePath;
  }
}

export function atomicWriteJson(
  target: string,
  value: unknown,
  fileSystem: PersistenceFileSystem = defaultFileSystem,
): void {
  const dir = dirname(target);
  if (!fileSystem.existsSync(dir)) fileSystem.mkdirSync(dir, { recursive: true });
  const tempPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fileSystem.writeFileSync(tempPath, JSON.stringify(value), "utf8");
    fileSystem.renameSync(tempPath, target);
  } catch (error) {
    try {
      fileSystem.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
}

export interface SearchResult {
  id: string;
  score: number;
  payload: VectorPointPayload;
}

function matchesFilter(point: VectorPoint, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "raw_tags_contains") {
      if (
        typeof expected !== "string" ||
        !point.payload.raw_tags.some((tag) => tag.includes(expected))
      ) {
        return false;
      }
      continue;
    }
    if ((point.payload as unknown as Record<string, unknown>)[key] !== expected) return false;
  }
  return true;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const words = text.toLowerCase().split(/[\s,，。！？、；：""''（）\[\]{}<>|\\/`~!@#$%^&*()+=\-_]+/).filter(Boolean);
  tokens.push(...words);
  for (const ch of text) {
    if (ch.trim().length > 0) {
      tokens.push(ch);
    }
  }
  return tokens;
}

function computeBM25Score(
  queryTokens: string[],
  docTokens: string[],
  idfMap: Map<string, number>,
  avgDocLen: number,
  k1: number,
  b: number
): number {
  const docLen = docTokens.length;
  let score = 0;
  const tfMap = new Map<string, number>();
  for (const t of docTokens) {
    tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
  }
  for (const qt of queryTokens) {
    const idf = idfMap.get(qt) ?? 0;
    if (idf === 0) continue;
    const tf = tfMap.get(qt) ?? 0;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
    score += idf * (numerator / denominator);
  }
  return score;
}

export class FakeQdrantClient implements QdrantClientLike {
  schemas: QdrantCollectionSchema[] = [];
  points: VectorPoint[] = [];
  private unavailable: boolean;
  private readonly fileSystem: PersistenceFileSystem;

  constructor(options?: FakeQdrantClientOptions) {
    this.unavailable = options?.unavailable ?? false;
    this.fileSystem = options?.fileSystem ?? defaultFileSystem;
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  private persistPath: string | null = null;

  /** Set the file path for automatic persistence after each upsert. */
  setPersistencePath(filePath: string): void {
    this.persistPath = filePath;
  }

  /** Serialize schemas + points to a JSON file. */
  saveToFile(filePath?: string): void {
    const target = filePath ?? this.persistPath;
    if (!target) throw new Error("No persistence path configured");
    const data = {
      schemas: this.schemas,
      points: this.points,
      savedAt: new Date().toISOString(),
    };
    atomicWriteJson(target, data, this.fileSystem);
  }

  /** Deserialize schemas + points from a JSON file. Returns true on success. */
  loadFromFile(filePath: string): boolean {
    if (!this.fileSystem.existsSync(filePath)) return false;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as { schemas?: unknown; points?: unknown };
      if (!Array.isArray(data.schemas) || !Array.isArray(data.points)) {
        throw new TypeError("Snapshot must contain schemas and points arrays");
      }
      const schemas = data.schemas as QdrantCollectionSchema[];
      const points = data.points as VectorPoint[];
      if (points.some((point) => !point || typeof point !== "object" || typeof point.id !== "string")) {
        throw new TypeError("Snapshot contains an invalid vector point");
      }
      this.schemas = schemas;
      this.points = points;
      this.persistPath = filePath;
      return this.points.length > 0;
    } catch (error) {
      if (error instanceof PersistenceCorruptionError) throw error;
      throw new PersistenceCorruptionError(filePath, error);
    }
  }

  /** Number of points currently in memory. */
  get pointCount(): number {
    return this.points.length;
  }

  // ── Qdrant operations ────────────────────────────────────────────────────

  private assertAvailable(): void {
    if (this.unavailable) {
      const err = new Error("Qdrant is unavailable") as Error & { code: string };
      err.code = "QDRANT_UNAVAILABLE";
      throw err;
    }
  }

  async ensureCollection(schema?: QdrantCollectionSchema): Promise<void> {
    this.assertAvailable();
    if (!schema) throw new TypeError("Collection schema is required");
    this.schemas.push(schema);
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    this.assertAvailable();
    for (const point of points) {
      const existingIdx = this.points.findIndex((p) => p.id === point.id);
      if (existingIdx >= 0) {
        this.points[existingIdx] = point;
      } else {
        this.points.push(point);
      }
    }
    if (this.persistPath) this.saveToFile();
  }

  async search(params: {
    vector: number[];
    limit: number;
    filter?: Record<string, unknown>;
    score_threshold?: number;
  }): Promise<SearchResult[]> {
    this.assertAvailable();
    const threshold = params.score_threshold ?? 0;
    const results: SearchResult[] = this.points.filter((point) => matchesFilter(point, params.filter)).map((point) => {
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

  bm25Search(params: { query: string; limit: number; filter?: Record<string, unknown> }): SearchResult[] {
    this.assertAvailable();
    const k1 = 1.2;
    const b = 0.75;
    const queryTokens = tokenize(params.query);

    const docs: Array<{ id: string; tokens: string[]; payload: VectorPointPayload }> = this.points
      .filter((point) => matchesFilter(point, params.filter))
      .map((point) => {
      const docText = [...point.payload.raw_tags, point.payload.normalized_text].join(" ");
      return {
        id: point.id,
        tokens: tokenize(docText),
        payload: point.payload,
      };
      });

    if (docs.length === 0) return [];

    const N = docs.length;
    const totalLen = docs.reduce((sum, d) => sum + d.tokens.length, 0);
    const avgDocLen = totalLen / N;

    const dfMap = new Map<string, number>();
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const t of doc.tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
        }
      }
    }

    const idfMap = new Map<string, number>();
    for (const [term, df] of dfMap) {
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      idfMap.set(term, idf);
    }

    const results: SearchResult[] = docs.map((doc) => ({
      id: doc.id,
      score: computeBM25Score(queryTokens, doc.tokens, idfMap, avgDocLen, k1, b),
      payload: doc.payload,
    }));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, params.limit);
  }
}
