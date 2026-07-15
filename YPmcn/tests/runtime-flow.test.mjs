import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyToolResult } from "../dist/hooks/results.js";
import {
  createRuntimeStateStore,
  markManualRecoveryConfirmed,
} from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-15T10:00:00+08:00");

function apply(store, toolName, params, result, overrides = {}) {
  return applyToolResult({
    sessionKey: "session-1",
    toolName: `mcp__ypmcn__${toolName}`,
    params,
    result,
    nowMs: NOW,
    store,
    ...overrides,
  });
}

function ok(data = {}, extra = {}) {
  return { success: true, trace_id: "trace-1", data, error: null, ...extra };
}

function advanceToDistribution(store) {
  apply(store, "validate_requirement", { payload: { brief: "test" } }, ok({ id: "req-1" }));
  apply(store, "search_creators", { id: "req-1" }, ok());
  apply(store, "rank_mcns", { id: "req-1", platform: "xhs" }, ok({
    mcn_recommendation_id: "mcnr-local-1",
  }));
  apply(store, "select_inquiry_form_fields", {}, ok({
    description: "kw_uid：达人 ID\nnickname：达人昵称",
  }));
  apply(store, "create_with_distributions", {
    projectName: "项目 A",
    deadline: "2026-07-16T18:00:00+08:00",
    columns: [{ key: "kw_uid" }, { name: "nickname" }],
    supplierIds: ["supplier-1"],
    prefillRows: [],
    prefillRowsBySupplier: {},
  }, ok({ project_id: "project-1", mcn_id: "mcn-1" }));
}

const syncParams = {
  requirement_id: "req-1",
  project_id: "project-1",
  mcn_id: "mcn-1",
};

describe("current Endpoint local session projection", () => {
  it("advances the full flow only from explicit actual evidence", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    advanceToDistribution(store);
    assert.deepEqual(
      {
        phase: store.get("session-1")?.phase,
        project_id: store.get("session-1")?.project_id,
        mcn_id: store.get("session-1")?.mcn_id,
      },
      { phase: "distribution_sync_pending", project_id: "project-1", mcn_id: "mcn-1" },
    );

    apply(store, "sync_mcn_inquiry_status", syncParams, ok({ inquiry_id: "inquiry-1" }));
    assert.equal(store.get("session-1")?.phase, "waiting_return");
    markManualRecoveryConfirmed(store, "session-1", NOW);
    apply(store, "sync_mcn_inquiry_status", syncParams, ok({ inquiry_id: "inquiry-1" }), {
      recoveryTrigger: "manual",
    });
    assert.equal(store.get("session-1")?.phase, "recovering");
    apply(store, "ingest_mcn_submissions", {
      inquiry_id: "inquiry-1", items: [{ kw_uid: "creator-1" }],
    }, ok(), { recoveryTrigger: "manual" });
    assert.equal(store.get("session-1")?.phase, "recovery_sync_pending");
    apply(store, "sync_mcn_inquiry_status", syncParams, ok(), {
      recoveryTrigger: "manual",
    });
    assert.equal(store.get("session-1")?.phase, "recovered");
    apply(store, "rank_creators", { requirement_id: "req-1", limit: 20 }, ok({ run_id: "1" }));
    assert.equal(store.get("session-1")?.phase, "recommendation_ready");
    apply(store, "create_submission_batch", { run_id: "1" }, ok());
    assert.equal(store.get("session-1")?.phase, "submission_batch_ready");
    apply(store, "record_client_feedback", { run_id: "1", feedback_items: [{}] }, ok());
    assert.equal(store.get("session-1")?.phase, "feedback_routing");
  });

  it("does not advance on unknown, ambiguous, or missing downstream evidence", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "validate_requirement", { payload: {} }, { data: { id: "req-1" } });
    assert.equal(store.get("session-1")?.phase, "requirement_draft");
    assert.equal(store.get("session-1")?.lastResultIssue?.code, "WRITE_RESULT_UNKNOWN");
    apply(store, "validate_requirement", { payload: {} }, {
      success: true, data: { id: "req-1" }, error: { message: "ambiguous" },
    });
    assert.equal(store.get("session-1")?.lastResultIssue?.code, "WRITE_RESULT_UNKNOWN");
    apply(store, "validate_requirement", { payload: {} }, ok({}));
    assert.equal(store.get("session-1")?.lastResultIssue?.code, "WRITE_RESULT_UNKNOWN");

    apply(store, "validate_requirement", { payload: {} }, ok({ id: "req-1" }));
    assert.equal(store.get("session-1")?.lastResultIssue, undefined);
    apply(store, "search_creators", { id: "req-1" }, ok());
    apply(store, "rank_mcns", { id: "req-1", platform: "xhs" }, ok());
    assert.equal(store.get("session-1")?.phase, "search_completed");
    assert.equal(store.get("session-1")?.lastResultIssue?.code, "WRITE_RESULT_UNKNOWN");
    apply(store, "rank_mcns", { id: "req-1", platform: "xhs" }, ok({ id: "mcnr-1" }));
    apply(store, "select_inquiry_form_fields", {}, ok({ description: "not parseable" }));
    assert.equal(store.get("session-1")?.phase, "mcn_planning");
    assert.equal(store.get("session-1")?.lastResultIssue?.code, "INTEGRATION_REQUIRED");
  });

  it("unwraps content-only MCP evidence without treating content as an advertised schema", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    apply(store, "validate_requirement", { payload: {} }, {
      content: [{ type: "text", text: JSON.stringify(ok({ id: "req-1" })) }],
    });
    assert.equal(store.get("session-1")?.phase, "requirement_ready");
    apply(store, "search_creators", { id: "req-1" }, {
      structuredContent: ok(),
    });
    assert.equal(store.get("session-1")?.phase, "search_completed");
  });

  it("keeps scheduled origin as hook context and never as an ingest provider argument", () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    advanceToDistribution(store);
    apply(store, "sync_mcn_inquiry_status", syncParams, ok({ inquiry_id: "inquiry-1" }));
    apply(store, "sync_mcn_inquiry_status", {
      ...syncParams, cron_job_id: "cron-1",
    }, ok({ inquiry_id: "inquiry-1" }), {
      recoveryTrigger: "scheduled", trigger: "cron",
    });
    assert.equal(store.get("session-1")?.lastSync?.trigger, "scheduled");
    apply(store, "ingest_mcn_submissions", {
      inquiry_id: "inquiry-1", items: [],
    }, ok(), { recoveryTrigger: "scheduled", trigger: "cron" });
    assert.equal(store.get("session-1")?.lastIngest?.trigger, "scheduled");
  });

  it("expires and deletes local projections", () => {
    let now = NOW;
    const store = createRuntimeStateStore({ now: () => now, ttlMs: 10 });
    store.set("session-1", { phase: "requirement_draft" });
    now += 10;
    assert.equal(store.get("session-1"), undefined);
    store.set("session-1", { phase: "requirement_draft" });
    store.delete("session-1");
    assert.equal(store.get("session-1"), undefined);
  });
});
