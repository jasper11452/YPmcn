import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  createSiliconFlowEmbeddingProvider,
  createSiliconFlowRerankerProvider,
} from "../dist/providers/index.js";
import {
  createSharedInitializer,
  searchVectorCandidates,
} from "../dist/tools/handlers.js";
import {
  atomicWriteJson,
  FakeQdrantClient,
} from "../dist/vector/qdrant.js";

function point(id, tags) {
  return {
    id,
    vector: [1, 0],
    payload: {
      platform: "xhs",
      platform_account_id: id,
      source_table: "xhs_creator_accounts",
      tag_type: "content",
      raw_tags: tags,
      normalized_text: tags.join("|"),
      source_updated_at: "2026-07-11T00:00:00Z",
      embedding_model_id: "fake",
      vector_version: "v1",
    },
  };
}

describe("shared vector initialization", () => {
  it("runs one loader for concurrent callers and clears a failed promise", async () => {
    let calls = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const shared = createSharedInitializer(async () => {
      calls += 1;
      await barrier;
      return { id: "store" };
    });
    const pending = [shared.get(), shared.get(), shared.get()];
    release();
    const values = await Promise.all(pending);
    assert.equal(calls, 1);
    assert.equal(values[0], values[1]);
    assert.equal(values[1], values[2]);

    let attempts = 0;
    const retryable = createSharedInitializer(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first load failed");
      return { id: "recovered" };
    });
    await assert.rejects(retryable.get(), /first load failed/);
    assert.equal((await retryable.get()).id, "recovered");
    assert.equal(attempts, 2);
  });
});

describe("geo search isolation", () => {
  it("never mutates shared points on success or failure", async () => {
    const qdrant = new FakeQdrantClient();
    qdrant.points = [point("shenyang", ["沈阳", "穿搭"]), point("guangdong", ["广东", "美食"])];
    const original = structuredClone(qdrant.points);
    const result = await searchVectorCandidates(qdrant, {
      vector: [1, 0], query: "穿搭", geoTerm: "沈阳", limit: 10,
    });
    assert.equal(result.dense.length, 1);
    assert.deepEqual(qdrant.points, original);

    const failing = {
      points: qdrant.points,
      async search() { throw new Error("dense failed"); },
      bm25Search() { return []; },
    };
    await assert.rejects(
      searchVectorCandidates(failing, { vector: [1, 0], query: "穿搭", geoTerm: "沈阳", limit: 10 }),
      /dense failed/,
    );
    assert.deepEqual(failing.points, original);
  });
});

describe("SiliconFlow request reliability", () => {
  it("maps an aborted embedding request to a typed timeout error", async () => {
    const provider = createSiliconFlowEmbeddingProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });
    await assert.rejects(
      provider.embed(["timeout"]),
      (error) => error.code === "PROVIDER_TIMEOUT" && error.retryable === true,
    );
  });

  it("batches embeddings and retries only transient HTTP failures", async () => {
    const batches = [];
    let calls = 0;
    const provider = createSiliconFlowEmbeddingProvider({
      apiKey: "test-key",
      batchSize: 2,
      maxRetries: 1,
      retryDelayMs: 0,
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(init.body);
        if (calls === 1) return new Response("busy", { status: 503 });
        batches.push(body.input);
        return Response.json({
          data: body.input.map((_, index) => ({ index, embedding: [calls, index] })),
        });
      },
    });
    const vectors = await provider.embed(["a", "b", "c", "d", "e"]);
    assert.equal(calls, 4);
    assert.deepEqual(batches, [["a", "b"], ["c", "d"], ["e"]]);
    assert.equal(vectors.length, 5);
  });

  it("uses the same timeout contract for reranking", async () => {
    const provider = createSiliconFlowRerankerProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });
    await assert.rejects(
      provider.rerank("query", ["doc"], 1),
      (error) => error.code === "PROVIDER_TIMEOUT",
    );
  });

  it("batches rerank documents and restores global indexes", async () => {
    const batches = [];
    const provider = createSiliconFlowRerankerProvider({
      apiKey: "test-key",
      batchSize: 2,
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        batches.push(body.documents);
        return Response.json({
          results: body.documents.map((doc, index) => ({
            index,
            relevance_score: Number(doc.slice(1)),
          })),
        });
      },
    });
    const result = await provider.rerank("query", ["d1", "d5", "d3", "d4", "d2"], 3);
    assert.deepEqual(batches, [["d1", "d5"], ["d3", "d4"], ["d2"]]);
    assert.deepEqual(result, [
      { index: 1, score: 5 },
      { index: 3, score: 4 },
      { index: 2, score: 3 },
    ]);
  });
});

describe("atomic fake persistence and health", () => {
  it("writes a temporary file and renames it over the target", () => {
    const calls = [];
    atomicWriteJson("/state/vector.json", { ok: true }, {
      existsSync: () => true,
      mkdirSync: (...args) => calls.push(["mkdir", ...args]),
      writeFileSync: (...args) => calls.push(["write", ...args]),
      renameSync: (...args) => calls.push(["rename", ...args]),
      rmSync: (...args) => calls.push(["remove", ...args]),
    });
    const write = calls.find(([name]) => name === "write");
    const rename = calls.find(([name]) => name === "rename");
    assert.match(write[1], /^\/state\/vector\.json\.tmp-/);
    assert.deepEqual(rename, ["rename", write[1], "/state/vector.json"]);
  });

  it("throws PERSISTENCE_CORRUPT instead of silently rebuilding", () => {
    const directory = mkdtempSync(join(tmpdir(), "vector-mcp-corrupt-"));
    try {
      const file = join(directory, "state.json");
      writeFileSync(file, "{not-json", "utf8");
      const qdrant = new FakeQdrantClient();
      assert.throws(
        () => qdrant.loadFromFile(file),
        (error) => error.code === "PERSISTENCE_CORRUPT",
      );
      assert.equal(readFileSync(file, "utf8"), "{not-json");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("surfaces corrupt persistence through the MCP health tool", async (testContext) => {
    const directory = mkdtempSync(join(tmpdir(), "vector-mcp-health-"));
    testContext.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "state.json");
    writeFileSync(file, "{not-json", "utf8");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/server.js", import.meta.url))], {
      env: { ...process.env, VECTOR_MCP_MODE: "fake", VECTOR_PERSIST_PATH: file },
      stdio: ["pipe", "pipe", "pipe"],
    });
    testContext.after(() => child.kill("SIGTERM"));
    const lines = createInterface({ input: child.stdout });
    const responses = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "health_check_vector_store", arguments: {} },
    })}\n`);
    const deadline = Date.now() + 2_000;
    while (responses.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(responses[0].result.success, false);
    assert.equal(responses[0].result.error.code, "PERSISTENCE_CORRUPT");
    child.stdin.end();
  });
});

describe("stdio MCP protocol", () => {
  it("accepts initialized notifications without emitting an error response", async (testContext) => {
    const directory = mkdtempSync(join(tmpdir(), "vector-mcp-protocol-"));
    testContext.after(() => rmSync(directory, { recursive: true, force: true }));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
      {
        env: { ...process.env, VECTOR_MCP_MODE: "fake", VECTOR_PERSIST_PATH: join(directory, "state.json") },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    testContext.after(() => child.kill("SIGTERM"));
    const lines = createInterface({ input: child.stdout });
    const responses = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const deadline = Date.now() + 2_000;
    while (responses.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(responses.map(({ id }) => id), [1, 2]);
    child.stdin.end();
  });
});
