// @ts-nocheck
import type { QdrantConfig } from "../config/types.js";

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
  unavailable?: boolean;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: VectorPointPayload;
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

  constructor(options?: FakeQdrantClientOptions) {
    this.unavailable = options?.unavailable ?? false;
  }

  private assertAvailable(): void {
    if (this.unavailable) {
      const err = new Error("Qdrant is unavailable") as Error & { code: string };
      err.code = "QDRANT_UNAVAILABLE";
      throw err;
    }
  }

  async ensureCollection(schema: QdrantCollectionSchema): Promise<void> {
    this.assertAvailable();
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
  }

  async search(params: {
    vector: number[];
    limit: number;
    filter?: Record<string, unknown>;
    score_threshold?: number;
  }): Promise<SearchResult[]> {
    this.assertAvailable();
    const threshold = params.score_threshold ?? 0;
    const results: SearchResult[] = this.points.map((point) => {
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

  bm25Search(params: { query: string; limit: number }): SearchResult[] {
    this.assertAvailable();
    const k1 = 1.2;
    const b = 0.75;
    const queryTokens = tokenize(params.query);

    const docs: Array<{ id: string; tokens: string[]; payload: VectorPointPayload }> = this.points.map((point) => {
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
