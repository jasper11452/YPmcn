export interface SiliconFlowRequestConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface SiliconFlowEmbeddingConfig extends SiliconFlowRequestConfig {
  model?: string;
  batchSize?: number;
}

export type ProviderErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_RESPONSE_INVALID";

export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function retryCount(value: number | undefined): number {
  const resolved = value ?? 2;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 5) {
    throw new TypeError("maxRetries must be an integer between 0 and 5");
  }
  return resolved;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function requestJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  config: SiliconFlowRequestConfig,
): Promise<T> {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderRequestError("PROVIDER_NETWORK_ERROR", "Fetch is unavailable", {
      retryable: false,
    });
  }
  const timeoutMs = positiveInteger(config.timeoutMs, 15_000, "timeoutMs");
  const maxRetries = retryCount(config.maxRetries);
  const retryDelayMs = config.retryDelayMs ?? 100;
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("retryDelayMs must be a non-negative finite number");
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const retryable = transientStatus(response.status);
        const body = (await response.text().catch(() => "")).slice(0, 512);
        const error = new ProviderRequestError(
          "PROVIDER_HTTP_ERROR",
          `SiliconFlow HTTP ${response.status}${body ? `: ${body}` : ""}`,
          { retryable, status: response.status },
        );
        if (retryable && attempt < maxRetries) {
          await delay(retryDelayMs * (attempt + 1));
          continue;
        }
        throw error;
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const timedOut = controller.signal.aborted || isAbortError(error);
      const mapped = new ProviderRequestError(
        timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
        timedOut ? `SiliconFlow request timed out after ${timeoutMs}ms` : "SiliconFlow network request failed",
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
  throw new ProviderRequestError("PROVIDER_NETWORK_ERROR", "SiliconFlow retry budget exhausted", {
    retryable: false,
  });
}

export function createSiliconFlowEmbeddingProvider(config: SiliconFlowEmbeddingConfig) {
  const baseUrl = config.baseUrl ?? "https://api.siliconflow.cn/v1";
  const model = config.model ?? "Qwen/Qwen3-Embedding-8B";
  const batchSize = positiveInteger(config.batchSize, 32, "batchSize");

  return {
    modelId() { return model; },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const json = await requestJsonWithRetry<{
          data: Array<{ embedding: number[]; index: number }>;
        }>(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: batch, encoding_format: "float" }),
        }, config);
        if (!Array.isArray(json.data) || json.data.length !== batch.length) {
          throw new ProviderRequestError(
            "PROVIDER_RESPONSE_INVALID",
            "SiliconFlow embedding response count does not match the request batch",
            { retryable: false },
          );
        }
        const ordered = [...json.data].sort((left, right) => left.index - right.index);
        if (ordered.some((entry, index) => entry.index !== index || !Array.isArray(entry.embedding))) {
          throw new ProviderRequestError(
            "PROVIDER_RESPONSE_INVALID",
            "SiliconFlow embedding response contains invalid indexes or vectors",
            { retryable: false },
          );
        }
        vectors.push(...ordered.map((entry) => new Float32Array(entry.embedding)));
      }
      return vectors;
    },
  };
}
