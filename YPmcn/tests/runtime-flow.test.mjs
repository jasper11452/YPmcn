import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyToolResult } from "../dist/hooks/results.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function qualified(toolName) {
  return `mcp__ypmcn__${toolName}`;
}

function standardResult(data, success = true) {
  return success
    ? { success: true, data, error: null }
    : {
      success: false,
      data: null,
      error: { code: "INVALID_INPUT", message: "failed", retryable: false },
    };
}

function workflowState(version, allowedActions, overrides = {}) {
  return standardResult({
    phase: "field_selection_ready",
    current_identifier: "mcnr-1",
    state_version: version,
    allowed_actions: allowedActions,
    pending_gates: [],
    identifiers: {
      requirement_id: "req-1",
      candidate_pool_id: "pool-1",
      mcn_recommendation_id: "mcnr-1",
      selection_result_id: "selection-1",
    },
    updated_at: "2026-07-11T10:00:00+08:00",
    ...overrides,
  });
}

function apply(store, toolName, params, result, overrides = {}) {
  return applyToolResult({
    sessionKey: "session-1",
    toolName: qualified(toolName),
    params,
    result,
    nowMs: NOW,
    store,
    ...overrides,
  });
}

function validDistributionResult(version) {
  return standardResult({
    provider_project_id: "provider-project-1",
    distribution_batch_ref: "distribution-1",
    send_operation_id: "send-1",
    selection_result_id: "selection-1",
    state_version: version,
    distributions: [
      {
        supplier_id: "supplier-1",
        provider_distribution_id: "provider-distribution-1",
        token: "token-1",
        fill_link: "https://example.invalid/fill/1",
      },
    ],
  });
}

function validValidationResult() {
  return standardResult({
    id: "req-2",
    status: "ready",
    requirement_head_id: "req-head-2",
    requirement_ids: ["req-2"],
    dictionary_version: "2026-07-12.1",
    dictionary_hash: "0".repeat(64),
  });
}

function validSyncResult(version, allowedActions) {
  return standardResult({
    inquiry_batch_id: "inquiry-batch-1",
    inquiry_ids: ["inquiry-1"],
    snapshot_id: "snapshot-1",
    lifecycle_status: "recover_requested",
    response_status: "partial",
    state_version: version,
    allowed_actions: allowedActions,
  });
}

describe("mvp-v2 runtime state flow", () => {
  it("adopts only a validated get_workflow_state projection", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(4, ["create_with_distributions"]));

    const state = store.get("session-1");
    assert.equal(state?.authoritative?.state_version, 4);
    assert.deepEqual(state?.authoritative?.allowed_actions, ["create_with_distributions"]);
    assert.equal(state?.requiresWorkflowRefresh, false);
    assert.equal(state?.phase, "field_selection_ready");
  });

  it("does not let an old authoritative projection overwrite a newer one", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(8, ["refresh_recovery", "rank_creators"], {
      phase: "recovered",
      lifecycle_status: "recovered",
      response_status: "completed",
    }));
    const before = store.get("session-1");

    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(7, ["create_with_distributions"]));
    assert.deepEqual(store.get("session-1"), before);

    apply(store, "create_with_distributions", { mcn_recommendation_id: "mcnr-1" }, validDistributionResult(8));
    assert.equal(store.get("session-1")?.authoritative, undefined);
    assert.equal(store.get("session-1")?.requiresWorkflowRefresh, true);
  });

  it("requires a get_workflow_state refresh after a valid write omits allowed_actions", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(4, ["create_with_distributions"]));
    apply(store, "create_with_distributions", { mcn_recommendation_id: "mcnr-1" }, validDistributionResult(5));

    const state = store.get("session-1");
    assert.equal(state?.lastServerStateVersion, 5);
    assert.equal(state?.authoritative, undefined);
    assert.equal(state?.requiresWorkflowRefresh, true);

    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(5, ["refresh_recovery"], {
      phase: "distribution_sync_pending",
      lifecycle_status: "sent",
      response_status: "pending",
    }));
    assert.equal(store.get("session-1")?.authoritative?.state_version, 5);
  });

  it("does not restore authority from an old projection after a write omits state_version", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { requirement_id: "req-draft" }, workflowState(4, ["validate_requirement"], {
      phase: "requirement_draft",
      current_identifier: "req-draft",
      identifiers: {},
    }));
    apply(store, "validate_requirement", { raw_messages_json: "[]" }, validValidationResult());
    const afterWrite = store.get("session-1");
    assert.equal(afterWrite?.lastServerStateVersion, 4);
    assert.equal(afterWrite?.requiresNewerWorkflowState, true);

    apply(store, "get_workflow_state", { requirement_id: "req-2" }, workflowState(4, ["search_creators"], {
      phase: "requirement_ready",
      current_identifier: "req-2",
      identifiers: { requirement_id: "req-2" },
    }));
    assert.deepEqual(store.get("session-1"), afterWrite);

    apply(store, "get_workflow_state", { requirement_id: "req-2" }, workflowState(5, ["search_creators"], {
      phase: "requirement_ready",
      current_identifier: "req-2",
      identifiers: { requirement_id: "req-2" },
    }));
    assert.equal(store.get("session-1")?.authoritative?.state_version, 5);
    assert.equal(store.get("session-1")?.requiresNewerWorkflowState, false);
  });

  it("adopts recovery allowed_actions from a validated server result", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(5, ["refresh_recovery"], {
      phase: "waiting_return",
      lifecycle_status: "waiting_return",
      response_status: "partial",
    }));
    apply(
      store,
      "sync_mcn_inquiry_status",
      { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1" },
      validSyncResult(6, ["request_recovery"]),
    );

    const state = store.get("session-1");
    assert.equal(state?.authoritative?.state_version, 6);
    assert.deepEqual(state?.authoritative?.allowed_actions, ["request_recovery"]);
    assert.equal(state?.authoritative?.lifecycle_status, "recover_requested");
    assert.equal(state?.requiresWorkflowRefresh, false);
  });

  it("rejects malformed output without changing state or evidence", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "get_workflow_state", { mcn_recommendation_id: "mcnr-1" }, workflowState(6, ["search_creators"]));
    const before = store.get("session-1");

    apply(store, "search_creators", { requirement_id: "req-1" }, standardResult({
      id: "pool-1",
      candidate_pool_written: true,
    }));
    assert.deepEqual(store.get("session-1"), before);
  });

  it("ignores bare and foreign result events instead of treating them as business evidence", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const result = workflowState(4, ["search_creators"]);
    for (const toolName of ["get_workflow_state", "mcp__foreign__get_workflow_state"]) {
      applyToolResult({
        sessionKey: "session-1",
        toolName,
        params: { mcn_recommendation_id: "mcnr-1" },
        result,
        nowMs: NOW,
        store,
      });
      assert.equal(store.get("session-1"), undefined, toolName);
    }
  });

  it("expires stale projections and deletes session state explicitly", () => {
    let now = NOW;
    const store = createRuntimeStateStore({ now: () => now, ttlMs: 1000 });
    store.set("session-1", { phase: "requirement_draft" });
    assert.equal(store.get("session-1")?.phase, "requirement_draft");
    now += 1001;
    assert.equal(store.get("session-1"), undefined);

    store.set("session-1", { phase: "requirement_draft" });
    store.delete("session-1");
    assert.equal(store.get("session-1"), undefined);
  });
});
