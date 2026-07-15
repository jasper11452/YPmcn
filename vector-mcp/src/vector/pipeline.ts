import { createHash } from "node:crypto";
import type { CreatorPlatform, CreatorRow, MysqlReadonlySource } from "../db/mysql-source.js";
import { projectCreatorText, projectQueryText } from "../source/projection.js";
import type { DerivedVectorPayload, NamedVectorHit, NamedVectorPoint, RealQdrantClient } from "./real-qdrant.js";

export interface EmbeddingLike {
  modelId(): string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface RerankerLike {
  modelId(): string;
  rerank(query: string, docs: string[], topN: number): Promise<Array<{ index: number; score: number }>>;
}

export interface PipelineDependencies {
  source: Pick<MysqlReadonlySource, "readCreators" | "rehydrate" | "loadProjectDescription">;
  qdrant: Pick<RealQdrantClient, "ensureCollection" | "upsert" | "search" | "health">;
  embedding: EmbeddingLike;
  reranker: RerankerLike;
  vectorVersion: string;
}

export interface HardFilters {
  platform?: CreatorPlatform;
  region?: string;
  followerMin?: number;
  followerMax?: number;
  priceMin?: number;
  priceMax?: number;
  compliance?: string;
}

export interface VectorSearchInput {
  queryText?: string;
  projectId?: string | number;
  platform: CreatorPlatform;
  filters?: HardFilters;
  limit?: number;
  candidateLimit?: number;
}

function deterministicPointId(row: CreatorRow): string {
  const hash = createHash("sha256")
    .update([row.platform, row.kwUid, row.sourceSnapshotDate].join("\u001f"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hash[12] = "5";
  hash[16] = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const value = hash.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function buildDerivedPayload(
  row: CreatorRow,
  modelId: string,
  vectorVersion: string,
  commercialVectorAvailable: boolean,
): DerivedVectorPayload {
  return {
    platform: row.platform,
    kw_uid: row.kwUid,
    source_table: row.sourceTable,
    source_row_id: row.sourceRowId,
    source_snapshot_date: row.sourceSnapshotDate,
    source_updated_at: row.sourceUpdatedAt,
    embedding_model_id: modelId,
    vector_version: vectorVersion,
    commercial_vector_available: commercialVectorAvailable,
  };
}

export async function buildNamedVectorPoints(
  rows: CreatorRow[],
  embedding: EmbeddingLike,
  vectorVersion: string,
): Promise<{ points: NamedVectorPoint[]; skipped: number }> {
  const projected = rows.flatMap((row) => {
    const text = projectCreatorText({ description: row.description, profile: row.profile, data_json: row.dataJson });
    return text.contentText ? [{ row, ...text }] : [];
  });
  const skipped = rows.length - projected.length;
  if (projected.length === 0) return { points: [], skipped };
  const inputs = projected.flatMap((item) => item.commercialText
    ? [item.contentText, item.commercialText]
    : [item.contentText]);
  const vectors = await embedding.embed(inputs);
  if (vectors.length !== inputs.length) throw new Error("Embedding provider returned an unexpected vector count");
  let vectorIndex = 0;
  const points = projected.map((item) => {
    const content = vectors[vectorIndex++];
    const commercial = item.commercialText ? vectors[vectorIndex++] : undefined;
    return {
      id: deterministicPointId(item.row),
      vector: {
        content: Array.from(content),
        ...(commercial ? { commercial: Array.from(commercial) } : {}),
      },
      payload: buildDerivedPayload(item.row, embedding.modelId(), vectorVersion, commercial !== undefined),
    };
  });
  return { points, skipped };
}

function dependencyReason(error: unknown, fallback: string): string {
  const code = (error as { code?: string })?.code;
  if (code === "QDRANT_UNAVAILABLE") return "vector_store_unavailable";
  if (code?.startsWith("PROVIDER_")) return fallback;
  return fallback;
}

function validLimit(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) throw new TypeError(`limit must be between 1 and ${max}`);
  return resolved;
}

function passesHardFilters(row: CreatorRow, filters: HardFilters): boolean {
  if (filters.platform && row.platform !== filters.platform) return false;
  if (filters.region) {
    const region = `${row.province ?? ""} ${row.city ?? ""}`.toLowerCase();
    if (!region.includes(filters.region.toLowerCase())) return false;
  }
  if (filters.followerMin !== undefined && (row.followerCount === undefined || row.followerCount < filters.followerMin)) return false;
  if (filters.followerMax !== undefined && (row.followerCount === undefined || row.followerCount > filters.followerMax)) return false;
  // This source has no verified price/compliance columns. Supplying those filters must fail closed.
  if (filters.priceMin !== undefined || filters.priceMax !== undefined || filters.compliance !== undefined) return false;
  return true;
}

function provenance(row: CreatorRow, commercialVectorAvailable: boolean) {
  return {
    authoritative_source: "mysql" as const,
    mysql_revalidated: true,
    platform: row.platform,
    kw_uid: row.kwUid,
    source_table: row.sourceTable,
    source_row_id: row.sourceRowId,
    source_snapshot_date: row.sourceSnapshotDate,
    source_updated_at: row.sourceUpdatedAt,
    commercial_vector_available: commercialVectorAvailable,
  };
}

function mergeHits(content: NamedVectorHit[], commercial: NamedVectorHit[]): NamedVectorHit[] {
  const ordered = new Map<string, { hit: NamedVectorHit; bestRank: number; firstList: number }>();
  for (const [listIndex, hits] of [content, commercial].entries()) {
    hits.forEach((hit, rank) => {
      const key = `${hit.payload.platform}:${hit.payload.kw_uid}`;
      const existing = ordered.get(key);
      if (!existing || rank < existing.bestRank) ordered.set(key, { hit, bestRank: rank, firstList: listIndex });
    });
  }
  return [...ordered.values()]
    .sort((a, b) => a.bestRank - b.bestRank || a.firstList - b.firstList || a.hit.payload.kw_uid.localeCompare(b.hit.payload.kw_uid))
    .map((entry) => entry.hit);
}

async function sqlOnlyResult(
  source: PipelineDependencies["source"],
  input: VectorSearchInput,
  reason: string,
  limit: number,
) {
  try {
    const read = await source.readCreators(input.platform, { limit: Math.max(limit, input.candidateLimit ?? limit) });
    if (read.status !== "available") {
      return { success: false as const, error: { code: "VECTOR_DEPENDENCY_ERROR", dependency: reason, source_status: read.reason } };
    }
    const rows = read.rows.filter((row) => passesHardFilters(row, input.filters ?? {})).slice(0, limit);
    return {
      success: true as const,
      retrieval_mode: "sql-only" as const,
      degraded_reason: reason,
      matches: rows.map((row, index) => ({
        rank: index + 1,
        platform: row.platform,
        kw_uid: row.kwUid,
        provenance: provenance(row, false),
      })),
    };
  } catch {
    return { success: false as const, error: { code: "VECTOR_DEPENDENCY_ERROR", dependency: reason, source_status: "unavailable" } };
  }
}

export class LocalVectorPipeline {
  constructor(private readonly deps: PipelineDependencies) {}

  async sync(platform: CreatorPlatform, options: { cursor?: string; limit?: number; dryRun?: boolean } = {}) {
    const read = await this.deps.source.readCreators(platform, { cursor: options.cursor, limit: options.limit });
    if (read.status === "unavailable") {
      return { success: false as const, status: "source_unavailable" as const, platform, reason: read.reason };
    }
    const built = await buildNamedVectorPoints(read.rows, this.deps.embedding, this.deps.vectorVersion);
    if (!options.dryRun && built.points.length > 0) {
      await this.deps.qdrant.ensureCollection();
      await this.deps.qdrant.upsert(built.points);
    }
    return {
      success: true as const,
      status: options.dryRun ? "validated" as const : "synced" as const,
      platform,
      counts: { scanned: read.rows.length, upserted: options.dryRun ? 0 : built.points.length, skipped: built.skipped },
      cursor: read.cursor ?? null,
      provenance: { source_table: read.rows[0]?.sourceTable ?? null, authoritative_source: "mysql" as const },
    };
  }

  async search(input: VectorSearchInput) {
    const limit = validLimit(input.limit, 20, 100);
    const candidateLimit = validLimit(input.candidateLimit, Math.max(limit, 50), 1000);
    let rawQuery = input.queryText;
    if (!rawQuery && input.projectId !== undefined) {
      try {
        rawQuery = await this.deps.source.loadProjectDescription(input.projectId) ?? undefined;
      } catch {
        return { success: false as const, error: { code: "SOURCE_DEPENDENCY_ERROR", dependency: "mysql_project_source" } };
      }
    }
    const query = projectQueryText(rawQuery);
    if (!query) return { success: false as const, error: { code: "NO_SEMANTIC_QUERY_TERMS" } };

    let queryVectors: Float32Array[];
    try {
      queryVectors = await this.deps.embedding.embed([query, query]);
      if (queryVectors.length !== 2) throw new Error("Embedding provider returned an unexpected vector count");
    } catch (error) {
      return sqlOnlyResult(this.deps.source, input, dependencyReason(error, "embedding_unavailable"), limit);
    }

    let merged: NamedVectorHit[];
    try {
      const [content, commercial] = await Promise.all([
        this.deps.qdrant.search("content", Array.from(queryVectors[0]), candidateLimit, input.platform),
        this.deps.qdrant.search("commercial", Array.from(queryVectors[1]), candidateLimit, input.platform),
      ]);
      merged = mergeHits(content, commercial);
    } catch (error) {
      return sqlOnlyResult(this.deps.source, input, dependencyReason(error, "vector_store_unavailable"), limit);
    }

    let current: CreatorRow[];
    try {
      current = await this.deps.source.rehydrate(input.platform, merged.map((hit) => hit.payload.kw_uid));
    } catch {
      return { success: false as const, error: { code: "SOURCE_DEPENDENCY_ERROR", dependency: "mysql_creator_source" } };
    }
    const byId = new Map(current.map((row) => [row.kwUid, row]));
    const vectorAvailability = new Map(merged.map((hit) => [
      `${hit.payload.platform}:${hit.payload.kw_uid}`,
      hit.payload.commercial_vector_available === true,
    ]));
    const candidates = merged
      .flatMap((hit) => byId.get(hit.payload.kw_uid) ? [byId.get(hit.payload.kw_uid)!] : [])
      .filter((row) => passesHardFilters(row, input.filters ?? {}));
    const rerankable = candidates.flatMap((row) => {
      const projected = projectCreatorText({ description: row.description, profile: row.profile, data_json: row.dataJson });
      const document = projectQueryText(`${projected.contentText} ${projected.commercialText}`);
      return document ? [{ row, document }] : [];
    });
    try {
      const ranking = await this.deps.reranker.rerank(query, rerankable.map((item) => item.document), rerankable.length);
      const matches = ranking.slice(0, limit).map((entry, index) => {
        const row = rerankable[entry.index]?.row;
        if (!row) throw new Error("Reranker returned an invalid index");
        return {
          rank: index + 1,
          platform: row.platform,
          kw_uid: row.kwUid,
          provenance: provenance(row, vectorAvailability.get(`${row.platform}:${row.kwUid}`) === true),
        };
      });
      return { success: true as const, retrieval_mode: "local-vector" as const, degraded_reason: null, matches };
    } catch (error) {
      return sqlOnlyResult(this.deps.source, input, dependencyReason(error, "reranker_unavailable"), limit);
    }
  }
}

export { deterministicPointId, passesHardFilters };
