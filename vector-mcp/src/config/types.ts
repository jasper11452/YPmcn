// @ts-nocheck
export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  connectionLimit?: number;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collectionName: string;
  vectorSize: number;
  distance: "Cosine" | "Dot" | "Euclid";
}

export interface BailianEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimension: number;
  batchSize?: number;
}

export interface BailianRerankConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  topN?: number;
}

export interface VectorMcpConfig {
  mysql: MysqlConfig;
  qdrant: QdrantConfig;
  bailian: { embedding: BailianEmbeddingConfig; rerank: BailianRerankConfig };
  mode: "fake" | "real";
}
