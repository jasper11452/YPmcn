import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  checkProviderUrl,
  compareProviderTools,
  extractSnapshotTools,
  sanitizeNetworkCause,
} from "../scripts/check-provider-contract.mjs";

const legacyProfilePath = fileURLToPath(
  new URL("../spec/profiles/legacy-1.9.4.json", import.meta.url),
);
const legacyProfile = JSON.parse(readFileSync(legacyProfilePath, "utf8"));
const targetProfile = JSON.parse(
  readFileSync(new URL("../spec/mcp.json", import.meta.url), "utf8"),
);

function currentToolDefinitions() {
  return [...targetProfile.requiredTools, ...targetProfile.optionalTools].map((name) => ({
    name,
    description: `current ${name}`,
    inputSchema: {
      type: "object",
      required: targetProfile.tools[name].required,
      properties: structuredClone(targetProfile.tools[name].properties),
    },
  }));
}

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
  it("keeps all vector tools out of the public business surface", () => {
    const names = currentToolDefinitions().map(({ name }) => name);
    assert.deepEqual(names, [
      "validate_requirement", "search_creators", "rank_mcns",
      "select_inquiry_form_fields", "create_with_distributions",
      "sync_mcn_inquiry_status", "ingest_mcn_submissions", "manual_source_creators",
      "rank_creators", "create_submission_batch", "record_client_feedback",
      "get_recommendation_run_detail", "get_creator_detail",
      "audit_manual_adjustment", "get_workflow_state",
    ]);
    assert.equal(names.includes("search_creator_tag_vectors"), false);
    for (const name of [
      "sync_creator_tag_vectors",
      "health_check_vector_store",
    ]) {
      assert.equal(names.includes(name), false);
    }
  });

  it("detects the legacy profile and reports exactly the four target tool gaps", () => {
    const report = compareProviderTools(legacyToolDefinitions());
    assert.equal(report.status, "FAIL");
    assert.equal(report.detectedProfile, "legacy-1.9.4");
    assert.deepEqual(report.missingTools, [
      "select_inquiry_form_fields",
      "create_with_distributions",
      "sync_mcn_inquiry_status",
      "get_workflow_state",
    ]);
    assert.ok(report.schemaDiffs.length > 0);
    assert.match(report.schemaHash, /^[a-f0-9]{64}$/);
  });

  it("passes a complete compatible target snapshot with a stable hash", () => {
    const definitions = currentToolDefinitions();
    const first = compareProviderTools(definitions);
    const second = compareProviderTools(structuredClone(definitions));
    assert.deepEqual(first, second);
    assert.equal(first.status, "PASS");
    assert.equal(first.detectedProfile, "current-endpoint");
    assert.deepEqual(first.missingTools, []);
    assert.deepEqual(first.schemaDiffs, []);
  });

  it("compares nullable anyOf branches recursively", () => {
    const definitions = currentToolDefinitions();
    const rank = definitions.find((tool) => tool.name === "rank_mcns");
    rank.inputSchema.properties.medium_risk_confirmation.anyOf[0].type = "number";

    const report = compareProviderTools(definitions);

    assert.equal(report.status, "FAIL");
    assert.deepEqual(report.schemaDiffs, [{
      tool: "rank_mcns",
      path: "inputSchema.properties.medium_risk_confirmation.anyOf[0].type",
      reason: "value_mismatch",
      expected: "object",
      actual: "number",
    }]);
  });

  it("does not synthesize or ignore a root additionalProperties constraint", () => {
    const definitions = currentToolDefinitions();
    for (const tool of definitions) tool.inputSchema.additionalProperties = false;
    const report = compareProviderTools(definitions);
    assert.equal(report.status, "FAIL");
    assert.equal(report.schemaDiffs.length, definitions.length);
    assert.ok(report.schemaDiffs.every((diff) =>
      diff.path === "inputSchema.additionalProperties" && diff.reason === "unexpected_schema"
    ));
  });

  it("ignores every pgy-prefixed tool", () => {
    const baseline = compareProviderTools(currentToolDefinitions());
    const withPgy = compareProviderTools([
      ...currentToolDefinitions(),
      { name: "pgy_secret", inputSchema: { type: "object" } },
    ]);
    assert.deepEqual(withPgy, baseline);
  });

  it("extracts tools/list snapshots without accepting malformed payloads", () => {
    const tools = legacyToolDefinitions();
    assert.deepEqual(extractSnapshotTools({ result: { tools } }), tools);
    assert.deepEqual(extractSnapshotTools({ tools }), tools);
    assert.throws(() => extractSnapshotTools({ result: {} }), /tools\/list snapshot/i);
  });

  it("reports only sanitized network cause fields", () => {
    const error = new TypeError("fetch failed", {
      cause: {
        code: "ECONNREFUSED",
        message: "connect failed with token=secret",
        stack: "sensitive stack",
        errors: [{
          address: "203.0.113.10",
          port: 32008,
          message: "http://user:password@203.0.113.10:32008/sse",
        }],
      },
    });

    const cause = sanitizeNetworkCause(error);

    assert.deepEqual(cause, {
      code: "ECONNREFUSED",
      address: "203.0.113.10",
      port: 32008,
    });
    assert.equal(JSON.stringify(cause).includes("secret"), false);
    assert.equal(JSON.stringify(cause).includes("password"), false);
  });

  it("uses only initialize, initialized notification, and tools/list over HTTP", async () => {
    const methods = [];
    const tools = currentToolDefinitions();
    const fetch = async (_url, options) => {
      const message = JSON.parse(options.body);
      methods.push(message.method);
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const result = message.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "test-provider", version: "3.0.0" },
          }
        : { tools };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const report = await checkProviderUrl("https://provider.invalid/mcp", { fetch });

    assert.equal(report.status, "PASS");
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(methods.includes("tools/call"), false);
  });
});
