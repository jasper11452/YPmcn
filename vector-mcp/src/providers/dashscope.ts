export type ProviderErrorCode =
  | "PROVIDER_CONFIGURATION_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID";

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface DashScopeRequestConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface DashScopeEmbeddingConfig extends DashScopeRequestConfig {
  model?: string;
  dimension?: number;
  batchSize?: number;
}

export interface DashScopeRerankerConfig extends DashScopeRequestConfig {
  model?: string;
  batchSize?: number;
  workspaceId?: string;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function retryCount(value: number | undefined): number {
  const resolved = value ?? 1;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 3) {
    throw new TypeError("maxRetries must be an integer between 0 and 3");
  }
  return resolved;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function requestJson<T>(url: string, init: RequestInit, config: DashScopeRequestConfig): Promise<T> {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderRequestError("PROVIDER_NETWORK_ERROR", "Provider fetch is unavailable", { retryable: false });
  }
  const timeoutMs = positiveInteger(config.timeoutMs, 15_000, "timeoutMs");
  const maxRetries = retryCount(config.maxRetries);
  const retryDelayMs = config.retryDelayMs ?? 100;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new TypeError("retryDelayMs must be non-negative");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const retryable = isTransient(response.status);
        const error = new ProviderRequestError(
          "PROVIDER_HTTP_ERROR",
          `DashScope request failed with HTTP ${response.status}`,
          { retryable, status: response.status },
        );
        if (retryable && attempt < maxRetries) {
          await delay(retryDelayMs * (attempt + 1));
          continue;
        }
        throw error;
      }
      try {
        return await response.json() as T;
      } catch (error) {
        throw new ProviderRequestError("PROVIDER_RESPONSE_INVALID", "DashScope returned invalid JSON", {
          retryable: false,
          cause: error,
        });
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const mapped = new ProviderRequestError(
        timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
        timedOut ? `DashScope request timed out after ${timeoutMs}ms` : "DashScope network request failed",
        { retryable: true, cause: error },
      );
      if (attempt < maxRetries) {
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      throw mapped;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new ProviderRequestError("PROVIDER_NETWORK_ERROR", "DashScope retry budget exhausted", { retryable: false });
}

function finiteVector(value: unknown, dimension?: number): value is number[] {
  return Array.isArray(value)
    && (dimension === undefined || value.length === dimension)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function createDashScopeEmbeddingProvider(config: DashScopeEmbeddingConfig) {
  if (!config.apiKey?.trim()) throw new TypeError("DASHSCOPE_API_KEY is required");
  const baseUrl = (config.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const model = config.model ?? "text-embedding-v4";
  const batchSize = positiveInteger(config.batchSize, 10, "batchSize");
  const dimension = config.dimension;
  if (dimension !== undefined) positiveInteger(dimension, dimension, "dimension");
  return {
    modelId: () => model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const json = await requestJson<{ data?: Array<{ index?: number; embedding?: unknown }> }>(
          `${baseUrl}/embeddings`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: batch, ...(dimension ? { dimensions: dimension } : {}) }),
          },
          config,
        );
        if (!Array.isArray(json.data) || json.data.length !== batch.length) {
          throw new ProviderRequestError("PROVIDER_RESPONSE_INVALID", "DashScope embedding count mismatch", { retryable: false });
        }
        const ordered = [...json.data].sort((a, b) => Number(a.index) - Number(b.index));
        if (ordered.some((entry, index) => entry.index !== index || !finiteVector(entry.embedding, dimension))) {
          throw new ProviderRequestError("PROVIDER_RESPONSE_INVALID", "DashScope embedding response is invalid", { retryable: false });
        }
        vectors.push(...ordered.map((entry) => new Float32Array(entry.embedding as number[])));
      }
      return vectors;
    },
  };
}

export function createDashScopeReranker(config: DashScopeRerankerConfig) {
  if (!config.apiKey?.trim()) throw new TypeError("DASHSCOPE_API_KEY is required");
  const endpoint = config.baseUrl?.replace(/\/$/, "")
    ?? (config.workspaceId?.trim()
      ? `https://${config.workspaceId.trim()}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks`
      : undefined);
  const model = config.model ?? "qwen3-rerank";
  const batchSize = positiveInteger(config.batchSize, 50, "batchSize");
  return {
    modelId: () => model,
    async rerank(query: string, docs: string[], topN: number): Promise<Array<{ index: number; score: number }>> {
      if (docs.length === 0) return [];
      if (!endpoint) {
        throw new ProviderRequestError(
          "PROVIDER_CONFIGURATION_INVALID",
          "DASHSCOPE_WORKSPACE_ID or DASHSCOPE_RERANK_BASE_URL is required for qwen3-rerank",
          { retryable: false },
        );
      }
      positiveInteger(topN, topN, "topN");
      const results: Array<{ index: number; score: number }> = [];
      for (let start = 0; start < docs.length; start += batchSize) {
        const batch = docs.slice(start, start + batchSize);
        const json = await requestJson<{ results?: Array<{ index?: number; relevance_score?: number }> }>(
          endpoint,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              query,
              documents: batch,
              top_n: batch.length,
            }),
          },
          config,
        );
        if (!Array.isArray(json.results)) {
          throw new ProviderRequestError("PROVIDER_RESPONSE_INVALID", "DashScope rerank results are missing", { retryable: false });
        }
        for (const entry of json.results) {
          if (!Number.isInteger(entry.index) || entry.index! < 0 || entry.index! >= batch.length
            || typeof entry.relevance_score !== "number" || !Number.isFinite(entry.relevance_score)) {
            throw new ProviderRequestError("PROVIDER_RESPONSE_INVALID", "DashScope rerank response is invalid", { retryable: false });
          }
          results.push({ index: start + entry.index!, score: entry.relevance_score });
        }
      }
      results.sort((a, b) => b.score - a.score || a.index - b.index);
      return results.slice(0, Math.min(topN, docs.length));
    },
  };
}
