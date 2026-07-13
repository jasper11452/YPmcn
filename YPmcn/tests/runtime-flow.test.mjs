import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyToolResult } from "../dist/hooks/results.js";
import {
  createRuntimeStateStore,
  markManualRecoveryConfirmed,
} from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function standardResult(data, success = true) {
  return { success, data, error: success ? null : { code: "INVALID_INPUT", message: "failed" } };
}

function selectionResult() {
  const definition = { key: "friendcount", name: "关注数", type: "BIGINT", required: true };
  return {
    success: true,
    url: "http://127.0.0.1:8000/demand-field-selector",
    message: "已接收需求字段选择结果",
    description: "friendcount：关注数",
    fields: { friendcount: definition },
    items: [definition],
    selected_count: 1,
    output_format: "数据库字段名：字段备注",
  };
}

function apply(store, toolName, params, result, overrides = {}) {
  return applyToolResult({
    sessionKey: "session-1",
    toolName: `ypmcn__${toolName}`,
    params,
    result,
    nowMs: NOW,
    store,
    ...overrides,
  });
}

function progressToDistribution(store) {
  apply(store, "validate_requirement", {}, standardResult({
    id: "req-1",
    status: "ready",
    requirement_head_id: "req-head-1",
    requirement_ids: ["req-1"],
    dictionary_version: "v1",
    dictionary_hash: "a".repeat(64),
  }));
  apply(store, "search_creators", { requirement_id: "req-1" }, standardResult({
    id: "pool-1",
    candidate_pool_written: true,
    requirement_snapshot_id: "snapshot-req-1",
    as_of_at: "2026-07-11T10:00:00+08:00",
  }));
  apply(store, "rank_mcns", { candidate_pool_id: "pool-1" }, standardResult({
    id: "mcnr-1",
    inquiry_advice: {},
    requirement_snapshot_id: "snapshot-req-1",
  }));
  apply(store, "select_inquiry_form_fields", { mcn_recommendation_id: "mcnr-1" }, selectionResult());
  apply(store, "create_with_distributions", { mcn_recommendation_id: "mcnr-1" }, standardResult({
    provider_project_id: "provider-project-1",
    distribution_batch_ref: "distribution-1",
    send_operation_id: "send-1",
    selection_result_id: "selection-1",
    state_version: 1,
    distributions: [{
      provider_distribution_id: "provider-distribution-1",
      supplier_id: "supplier-1",
      token: "token-1",
      fill_link: "https://example.invalid/fill/token-1",
    }],
  }));
}

function syncResult(lifecycle_status, response_status = "pending") {
  return standardResult({
    inquiry_batch_id: "inquiry-batch-1",
    inquiry_ids: ["inquiry-1"],
    snapshot_id: "snapshot-1",
    lifecycle_status,
    response_status,
    state_version: 1,
    allowed_actions: lifecycle_status === "recovered"
      ? ["rank_creators"]
      : ["refresh_recovery"],
  });
}

describe("mvp-v2 runtime state flow", () => {
  it("does not enter waiting_return until the first distribution sync succeeds", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    progressToDistribution(store);
    assert.equal(store.get("session-1")?.phase, "distribution_sync_pending");

    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1",
      requirement_id: "req-1",
    }, standardResult(undefined, false));
    assert.equal(store.get("session-1")?.phase, "distribution_sync_pending");

    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1",
      requirement_id: "req-1",
    }, syncResult("waiting_return"));
    assert.equal(store.get("session-1")?.phase, "waiting_return");
    assert.equal(store.get("session-1")?.inquiry_batch_id, "inquiry-batch-1");
  });

  it("runs the manual sync -> ingest -> sync path before ranking", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    progressToDistribution(store);
    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("waiting_return"));

    markManualRecoveryConfirmed(store, "session-1", NOW);
    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("recovering", "partial"), { recoveryTrigger: "manual" });
    assert.equal(store.get("session-1")?.phase, "recovering");

    apply(store, "ingest_mcn_submissions", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "manual",
    }, standardResult({
      id: "ingest-1",
      accepted_count: 8,
      rejected_count: 2,
      created_submission_item_count: 8,
      recovery_operation_id: "recovery-1",
      state_version: 1,
      allowed_actions: ["finalize_recovery"],
    }), { recoveryTrigger: "manual" });
    assert.equal(store.get("session-1")?.phase, "recovery_sync_pending");

    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("recovered", "completed"), { recoveryTrigger: "manual" });
    assert.equal(store.get("session-1")?.phase, "recovered");

    apply(store, "rank_creators", { mcn_recommendation_id: "mcnr-1" }, standardResult({
      run_id: "run-1",
      ranked_count: 30,
      requirement_snapshot_id: "snapshot-req-1",
      state_version: 1,
    }));
    assert.equal(store.get("session-1")?.phase, "recommendation_ready");
    assert.equal(store.get("session-1")?.run_id, "run-1");
  });

  it("runs the scheduled sync -> ingest -> sync path with cron evidence", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    progressToDistribution(store);
    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("waiting_return"));
    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("recovering", "partial"), { trigger: "cron", recoveryTrigger: "scheduled" });
    assert.equal(store.get("session-1")?.phase, "recovering");

    apply(store, "ingest_mcn_submissions", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "scheduled",
    }, standardResult({
      id: "ingest-1",
      accepted_count: 8,
      rejected_count: 0,
      created_submission_item_count: 8,
      recovery_operation_id: "recovery-1",
      state_version: 1,
      allowed_actions: ["finalize_recovery"],
    }), { trigger: "cron", recoveryTrigger: "scheduled" });
    assert.equal(store.get("session-1")?.phase, "recovery_sync_pending");

    apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("recovered", "completed"), { trigger: "cron", recoveryTrigger: "scheduled" });
    assert.equal(store.get("session-1")?.phase, "recovered");
  });

  it("keeps terminal recovery authoritative and never reopens ingest", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "recovered",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      lastSync: { at: NOW, lifecycle_status: "recovered", response_status: "completed", trigger: "manual" },
    });
    const state = apply(store, "sync_mcn_inquiry_status", {
      mcn_recommendation_id: "mcnr-1", requirement_id: "req-1",
    }, syncResult("recovered", "completed"), { recoveryTrigger: "manual" });
    assert.equal(state?.phase, "recovered");
    assert.equal(state?.lastSync?.lifecycle_status, "recovered");
  });

  it("unwraps content-only MCP results before enforcing the output contract", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", { phase: "requirement_ready", requirement_id: "req-1" });

    apply(store, "search_creators", { requirement_id: "req-1" }, {
      content: [{ type: "text", text: JSON.stringify(standardResult({
        id: "pool-incomplete",
        candidate_pool_written: true,
      })) }],
      details: { mcpServer: "ypmcn", mcpTool: "search_creators" },
    });
    assert.equal(store.get("session-1")?.phase, "requirement_ready");

    apply(store, "search_creators", { requirement_id: "req-1" }, {
      content: [{ type: "text", text: JSON.stringify(standardResult({
        id: "pool-1",
        candidate_pool_written: true,
        requirement_snapshot_id: "snapshot-req-1",
        as_of_at: "2026-07-11T10:00:00+08:00",
      })) }],
      details: { mcpServer: "ypmcn", mcpTool: "search_creators" },
    });
    assert.equal(store.get("session-1")?.phase, "candidate_pool_ready");
    assert.equal(store.get("session-1")?.candidate_pool_id, "pool-1");
  });

  it("does not relabel a stale field-selection result as the current selection", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const current = { key: "postcount", name: "作品数", type: "BIGINT", required: true };
    store.set("session-1", {
      phase: "field_selection_ready",
      mcn_recommendation_id: "mcnr-current",
      fieldSelection: {
        fields: { postcount: current },
        items: [current],
        selected_count: 1,
      },
    });

    apply(store, "select_inquiry_form_fields", {
      mcn_recommendation_id: "mcnr-stale",
    }, selectionResult());

    assert.equal(store.get("session-1")?.mcn_recommendation_id, "mcnr-current");
    assert.equal(store.get("session-1")?.fieldSelection?.items[0].key, "postcount");
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
