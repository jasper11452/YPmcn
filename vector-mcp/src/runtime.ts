import { createMysqlReadonlySource, mysqlSourceConfigFromEnv } from "./db/mysql-source.js";
import { createDashScopeEmbeddingProvider, createDashScopeReranker } from "./providers/dashscope.js";
import { LocalVectorPipeline } from "./vector/pipeline.js";
import { RealQdrantClient } from "./vector/real-qdrant.js";

function positiveEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

export async function createRealRuntime(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) throw new TypeError("DASHSCOPE_API_KEY is required in real mode");
  const dimension = positiveEnv(env, "QDRANT_VECTOR_SIZE", 1024);
  const mysql = await createMysqlReadonlySource(mysqlSourceConfigFromEnv(env));
  const qdrant = new RealQdrantClient({
    url: env.QDRANT_URL ?? "http://localhost:6333",
    collectionName: env.QDRANT_COLLECTION ?? "creator_local_vectors",
    vectorSize: dimension,
    apiKey: env.QDRANT_API_KEY,
    timeoutMs: positiveEnv(env, "VECTOR_HTTP_TIMEOUT_MS", 15_000),
  });
  const common = {
    apiKey,
    timeoutMs: positiveEnv(env, "VECTOR_HTTP_TIMEOUT_MS", 15_000),
    maxRetries: env.VECTOR_HTTP_MAX_RETRIES === undefined ? 1 : Number(env.VECTOR_HTTP_MAX_RETRIES),
  };
  const embedding = createDashScopeEmbeddingProvider({
    ...common,
    baseUrl: env.DASHSCOPE_EMBEDDING_BASE_URL,
    model: env.DASHSCOPE_EMBEDDING_MODEL ?? "text-embedding-v4",
    dimension,
  });
  const reranker = createDashScopeReranker({
    ...common,
    baseUrl: env.DASHSCOPE_RERANK_BASE_URL,
    workspaceId: env.DASHSCOPE_WORKSPACE_ID,
    model: env.DASHSCOPE_RERANK_MODEL ?? "qwen3-rerank",
  });
  return {
    pipeline: new LocalVectorPipeline({
      source: mysql.source,
      qdrant,
      embedding,
      reranker,
      vectorVersion: env.VECTOR_VERSION ?? "local-v1",
    }),
    qdrant,
    close: mysql.close,
  };
}
