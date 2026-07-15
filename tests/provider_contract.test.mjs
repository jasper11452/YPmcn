import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createToolDefinitions } from "../reference-mcp/state.mjs";
import {
  checkProviderUrl,
  compareProviderTools,
  extractSnapshotTools,
} from "../scripts/check-provider-contract.mjs";

const legacyProfilePath = fileURLToPath(
  new URL("../spec/profiles/legacy-1.9.4.json", import.meta.url),
);
const legacyProfile = JSON.parse(readFileSync(legacyProfilePath, "utf8"));

function legacyToolDefinitions() {
  return legacyProfile.observedSummary.toolNames.map((name) => {
    const contract = legacyProfile.observedSummary.tools[name];
    return {
      name,
      description: `observed ${name}`,
      inputSchema: {
        type: "object",
        required: contract.required,
        properties: contract.properties,
        additionalProperties: false,
      },
    };
  });
}

describe("read-only provider contract checker", () => {
  it("keeps the business provider tool set closed without vector operations tools", () => {
    const names = createToolDefinitions().map(({ name }) => name);
    assert.deepEqual(names, [
      "validate_requirement", "search_creators", "rank_mcns",
      "select_inquiry_form_fields", "create_with_distributions", "sync_mcn_inquiry_status",
      "ingest_mcn_submissions", "manual_source_creators", "rank_creators",
      "create_submission_batch", "record_client_feedback", "get_recommendation_run_detail",
      "get_creator_detail", "audit_manual_adjustment", "get_workflow_state",
    ]);
    for (const name of [
      "sync_creator_tag_vectors", "search_creator_tag_vectors", "health_check_vector_store",
    ]) assert.equal(names.includes(name), false);
  });

  it("detects the legacy profile and reports exactly the three target tool gaps", () => {
    const report = compareProviderTools(legacyToolDefinitions());
    assert.equal(report.status, "FAIL");
    assert.equal(report.detectedProfile, "legacy-1.9.4");
    assert.deepEqual(report.missingTools, [
      "select_inquiry_form_fields",
      "create_with_distributions",
      "sync_mcn_inquiry_status",
    ]);
    assert.ok(report.schemaDiffs.length > 0);
    assert.match(report.schemaHash, /^[a-f0-9]{64}$/);
  });

  it("passes a complete compatible target snapshot with a stable hash", () => {
    const definitions = createToolDefinitions();
    const first = compareProviderTools(definitions);
    const second = compareProviderTools(structuredClone(definitions));
    assert.deepEqual(first, second);
    assert.equal(first.status, "PASS");
    assert.equal(first.detectedProfile, "mvp-v2");
    assert.deepEqual(first.missingTools, []);
    assert.deepEqual(first.schemaDiffs, []);
  });

  it("extracts tools/list snapshots without accepting malformed payloads", () => {
    const tools = legacyToolDefinitions();
    assert.deepEqual(extractSnapshotTools({ result: { tools } }), tools);
    assert.deepEqual(extractSnapshotTools({ tools }), tools);
    assert.throws(() => extractSnapshotTools({ result: {} }), /tools\/list snapshot/i);
  });

  it("uses only initialize, initialized notification, and tools/list over HTTP", async (testContext) => {
    const methods = [];
    const tools = createToolDefinitions();
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      methods.push(message.method);
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test-provider", version: "3.0.0" },
          }
        : { tools };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    testContext.after(() => server.close());
    const address = server.address();
    const report = await checkProviderUrl(`http://127.0.0.1:${address.port}/mcp`);

    assert.equal(report.status, "PASS");
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(methods.includes("tools/call"), false);
  });
});
