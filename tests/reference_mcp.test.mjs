import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  createReferenceState,
  createToolDefinitions,
} from "../reference-mcp/state.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../reference-mcp/server.mjs", import.meta.url));
const START = Date.parse("2026-07-11T10:00:00+08:00");

function value(callResult) {
  assert.equal(callResult.simulated, true);
  return callResult.output;
}

describe("network-free mvp-v2 reference MCP", () => {
  it("publishes every target tool directly from the approved profile", () => {
    const definitions = createToolDefinitions();
    assert.equal(definitions.length, 15);
    assert.deepEqual(
      definitions.map(({ name }) => name),
      [
        "validate_requirement",
        "search_creators",
        "rank_mcns",
        "select_inquiry_form_fields",
        "create_with_distributions",
        "sync_mcn_inquiry_status",
        "ingest_mcn_submissions",
        "manual_source_creators",
        "rank_creators",
        "create_submission_batch",
        "record_client_feedback",
        "get_recommendation_run_detail",
        "get_creator_detail",
        "audit_manual_adjustment",
        "get_workflow_state",
      ],
    );
    for (const definition of definitions) {
      assert.equal(definition.inputSchema.type, "object", definition.name);
      assert.equal(definition.inputSchema.additionalProperties, false, definition.name);
    }
  });

  it("executes the complete v2 chain deterministically and idempotently without network", async () => {
    let now = START;
    let networkCalls = 0;
    const state = createReferenceState({
      now: () => now,
      fetch: async () => {
        networkCalls += 1;
        throw new Error("reference MCP must not access the network");
      },
    });

    const requirement = value(await state.callTool("validate_requirement", {
      raw_messages: [{ role: "client", content: "小红书 2 位创作者，预算 2 万" }],
    }));
    assert.equal(requirement.success, true);
    const requirementId = requirement.data.id;

    const pool = value(await state.callTool("search_creators", { requirement_id: requirementId }));
    const poolId = pool.data.id;
    const mcn = value(await state.callTool("rank_mcns", { candidate_pool_id: poolId }));
    const mcnRecommendationId = mcn.data.id;

    const selection = value(await state.callTool("select_inquiry_form_fields", {
      mcn_recommendation_id: mcnRecommendationId,
    }));
    assert.equal(selection.success, true);
    assert.equal(selection.selected_count, selection.items.length);

    const deadline = new Date(now + 60_000).toISOString();
    const distribution = value(await state.callTool("create_with_distributions", {
      mcn_recommendation_id: mcnRecommendationId,
      projectName: "reference-only",
      description: "simulated provider distribution",
      deadline,
      remindAt: new Date(now + 30_000).toISOString(),
      usageScope: "project",
      supplierIds: ["supplier-1", "supplier-2"],
      columns: selection.items,
      sendWechatNotification: true,
      preview_only: false,
    }));
    assert.equal(distribution.data.distributions.length, 2);

    const syncArgs = {
      mcn_recommendation_id: mcnRecommendationId,
      requirement_id: requirementId,
    };
    const initialSync = value(await state.callTool("sync_mcn_inquiry_status", syncArgs));
    const repeatedInitialSync = value(await state.callTool("sync_mcn_inquiry_status", syncArgs));
    assert.deepEqual(repeatedInitialSync, initialSync);
    assert.equal(initialSync.data.lifecycle_status, "waiting_return");

    now = Date.parse(deadline) + 1;
    const recoverySync = value(await state.callTool("sync_mcn_inquiry_status", syncArgs));
    const repeatedRecoverySync = value(await state.callTool("sync_mcn_inquiry_status", syncArgs));
    assert.deepEqual(repeatedRecoverySync, recoverySync);
    assert.equal(recoverySync.data.lifecycle_status, "recovering");

    const ingestArgs = { ...syncArgs, trigger: "manual" };
    const ingest = value(await state.callTool("ingest_mcn_submissions", ingestArgs));
    const repeatedIngest = value(await state.callTool("ingest_mcn_submissions", ingestArgs));
    assert.deepEqual(repeatedIngest, ingest);
    assert.equal(ingest.data.created_submission_item_count, 2);
    assert.equal(state.snapshot().submissionItemCount, 2);

    const finalSync = value(await state.callTool("sync_mcn_inquiry_status", syncArgs));
    assert.equal(finalSync.data.lifecycle_status, "recovered");

    const manual = value(await state.callTool("manual_source_creators", {
      requirement_id: requirementId,
      manual_results: [{
        platform: "xhs",
        platform_account_id: "manual-creator-1",
        profile_url: "https://example.invalid/manual-creator-1",
      }],
    }));
    assert.equal(manual.data.imported_count, 1);

    const ranking = value(await state.callTool("rank_creators", {
      mcn_recommendation_id: mcnRecommendationId,
      manual_batch_ids: [manual.data.manual_batch_id],
    }));
    const runId = ranking.data.run_id;
    const batch = value(await state.callTool("create_submission_batch", { run_id: runId }));
    const feedback = value(await state.callTool("record_client_feedback", {
      run_id: runId,
      feedback_items: [{ submission_id: batch.data.id, status: "accepted" }],
    }));
    assert.equal(feedback.data.updated_count, 1);
    assert.equal(state.snapshot().phase, "feedback_routing");
    assert.equal(networkCalls, 0);
  });

  it("speaks JSON-RPC MCP 2024-11-05 over stdio and marks calls simulated", async (testContext) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    testContext.after(() => child.kill("SIGTERM"));
    const lines = createInterface({ input: child.stdout });
    const responses = [];
    lines.on("line", (line) => responses.push(JSON.parse(line)));

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "validate_requirement",
        arguments: { raw_messages: [{ role: "client", content: "reference" }] },
      },
    })}\n`);

    const deadline = Date.now() + 2_000;
    while (responses.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(responses.length, 3);
    assert.equal(responses[0].result.protocolVersion, "2024-11-05");
    assert.equal(responses[1].result.tools.length, 15);
    assert.equal(responses[2].result._meta.simulated, true);
    assert.equal(responses[2].result.structuredContent.success, true);

    child.stdin.end();
    await once(child, "exit");
  });
});

