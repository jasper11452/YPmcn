import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFakeE2eValidation } from "./fakeE2e.js";
import { runRealValidation } from "./realValidation.js";
// ─── Test 1: fake e2e validation succeeds ────────────────────────────────────
describe("runFakeE2eValidation", () => {
    it("returns success in fake mode with synced count and searched=true", async () => {
        const result = await runFakeE2eValidation();
        assert.equal(result.success, true);
        assert.equal(result.mode, "fake");
        assert.ok(result.synced > 0, `synced should be > 0, got ${result.synced}`);
        assert.equal(result.searched, true);
        assert.equal(result.error, undefined);
    });
});
// ─── Test 2: real validation with empty env returns missing-config ───────────
describe("runRealValidation — empty env", () => {
    it("returns skipped missing-config result with known error code", () => {
        // Pass an env with VECTOR_MCP_MODE=real but no credentials
        const emptyEnv = {
            VECTOR_MCP_MODE: "real",
        };
        const result = runRealValidation(emptyEnv);
        assert.equal(result.success, false);
        assert.equal(result.skipped, true);
        // Should be one of the known config error codes
        const knownCodes = [
            "MYSQL_CONFIG_MISSING",
            "QDRANT_CONFIG_MISSING",
            "BAILIAN_CONFIG_MISSING",
        ];
        assert.ok(knownCodes.includes(result.code), `Expected one of ${knownCodes.join(", ")}, got "${result.code}"`);
        assert.ok(result.missing && result.missing.length > 0, "missing should contain env var names");
    });
});
// ─── Test 3: real validation with full fake env returns NOT_IMPLEMENTED ──────
describe("runRealValidation — complete fake real env", () => {
    it("returns REAL_VALIDATION_NOT_IMPLEMENTED and does not attempt network", () => {
        // Provide all required env vars with fake values
        const fullEnv = {
            VECTOR_MCP_MODE: "real",
            MYSQL_HOST: "127.0.0.1",
            MYSQL_PORT: "3306",
            MYSQL_USER: "test_user",
            MYSQL_PASSWORD: "test_password",
            MYSQL_DATABASE: "test_db",
            QDRANT_URL: "http://127.0.0.1:6333",
            QDRANT_COLLECTION: "test_collection",
            QDRANT_VECTOR_SIZE: "128",
            BAILIAN_API_KEY: "fake_key",
            BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/api/v1",
            BAILIAN_EMBEDDING_MODEL: "text-embedding-v3",
            BAILIAN_EMBEDDING_DIM: "128",
            BAILIAN_RERANK_MODEL: "gte-rerank-hybrid",
        };
        const result = runRealValidation(fullEnv);
        assert.equal(result.success, false);
        assert.equal(result.skipped, true);
        assert.equal(result.code, "REAL_VALIDATION_NOT_IMPLEMENTED");
        // missing should be absent or empty
        assert.ok(!result.missing || result.missing.length === 0, "missing should be empty when config is complete");
    });
});
