import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runBeforeToolCallGuards } from "../dist/hooks/guards.js";
import { createRuntimeStateStore } from "../dist/hooks/runtime-state.js";

const NOW = Date.parse("2026-07-11T10:00:00+08:00");

function fieldDefinition(key = "friendcount", name = "关注数") {
  return { key, name, type: "BIGINT", required: true };
}

function readyDistributionParams(overrides = {}) {
  return {
    mcn_recommendation_id: "mcnr-1",
    projectName: "测试项目",
    description: "请按时回填",
    deadline: "2026-07-12T18:00:00+08:00",
    remindAt: "2026-07-12T12:00:00+08:00",
    usageScope: "project",
    supplierIds: ["supplier-1"],
    columns: [fieldDefinition()],
    sendWechatNotification: true,
    preview_only: false,
    ...overrides,
  };
}

function sendContext(store, overrides = {}) {
  return {
    toolName: "create_with_distributions",
    params: readyDistributionParams(),
    sessionKey: "session-1",
    toolCallId: "call-1",
    operatorRole: "media",
    nowMs: NOW,
    gateState: {
      supplyConfirmed: true,
      mcnConfirmed: true,
      messageConfirmed: true,
    },
    store,
    ...overrides,
  };
}

describe("mvp-v2 before-tool guards", () => {
  it("accepts exact semantic IDs and rejects legacy chained IDs", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "requirement_ready",
      requirement_id: "req-1",
    });

    const allowed = await runBeforeToolCallGuards({
      toolName: "search_creators",
      params: { requirement_id: "req-1" },
      sessionKey: "session-1",
      toolCallId: "call-search",
      operatorRole: "media",
      nowMs: NOW,
      store,
    });
    assert.equal(allowed, undefined);

    const blocked = await runBeforeToolCallGuards({
      toolName: "search_creators",
      params: { id: "req-1", demand_id: "legacy", demand_version: 1 },
      sessionKey: "session-1",
      toolCallId: "call-search-legacy",
      operatorRole: "media",
      nowMs: NOW,
      store,
    });
    assert.equal(blocked?.block, true);
    assert.match(blocked?.blockReason ?? "", /SCHEMA_MISMATCH/);
  });

  it("fails a distribution closed when session, call ID, or role evidence is missing", async () => {
    for (const missing of ["sessionKey", "toolCallId", "operatorRole"]) {
      const store = createRuntimeStateStore({ now: () => NOW });
      store.set("session-1", {
        phase: "field_selection_ready",
        requirement_id: "req-1",
        candidate_pool_id: "pool-1",
        mcn_recommendation_id: "mcnr-1",
        fieldSelection: {
          fields: { friendcount: fieldDefinition() },
          items: [fieldDefinition()],
          selected_count: 1,
        },
      });
      const ctx = sendContext(store);
      delete ctx[missing];
      const result = await runBeforeToolCallGuards(ctx);
      assert.equal(result?.block, true, missing);
      assert.match(result?.blockReason ?? "", /CONFIRMATION_REQUIRED|INVALID_INPUT/, missing);
    }
  });

  it("requires every send confirmation and current field-selection proof", async () => {
    const cases = [
      { gateState: { supplyConfirmed: false, mcnConfirmed: true, messageConfirmed: true } },
      { gateState: { supplyConfirmed: true, mcnConfirmed: false, messageConfirmed: true } },
      { gateState: { supplyConfirmed: true, mcnConfirmed: true, messageConfirmed: false } },
      { columns: [fieldDefinition("postcount", "作品数")] },
    ];

    for (const testCase of cases) {
      const store = createRuntimeStateStore({ now: () => NOW });
      store.set("session-1", {
        phase: "field_selection_ready",
        requirement_id: "req-1",
        candidate_pool_id: "pool-1",
        mcn_recommendation_id: "mcnr-1",
        fieldSelection: {
          fields: { friendcount: fieldDefinition() },
          items: [fieldDefinition()],
          selected_count: 1,
        },
      });
      const result = await runBeforeToolCallGuards(sendContext(store, {
        gateState: testCase.gateState ?? sendContext(store).gateState,
        params: readyDistributionParams(testCase.columns ? { columns: testCase.columns } : {}),
      }));
      assert.equal(result?.block, true);
      assert.match(result?.blockReason ?? "", /CONFIRMATION_REQUIRED|FIELD_SELECTION_INVALID/);
    }
  });

  it("rejects preview sends and past reminder timestamps", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "field_selection_ready",
      requirement_id: "req-1",
      candidate_pool_id: "pool-1",
      mcn_recommendation_id: "mcnr-1",
      fieldSelection: {
        fields: { friendcount: fieldDefinition() },
        items: [fieldDefinition()],
        selected_count: 1,
      },
    });

    const preview = await runBeforeToolCallGuards(sendContext(store, {
      params: readyDistributionParams({ preview_only: true }),
    }));
    assert.equal(preview?.block, true);
    assert.match(preview?.blockReason ?? "", /SCHEMA_MISMATCH/);

    const expired = await runBeforeToolCallGuards(sendContext(store, {
      params: readyDistributionParams({ remindAt: "2026-07-10T12:00:00+08:00" }),
    }));
    assert.equal(expired?.block, true);
    assert.match(expired?.blockReason ?? "", /INVALID_INPUT/);
  });

  it("blocks shell and curl bypasses of the provider write", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    const result = await runBeforeToolCallGuards({
      toolName: "exec",
      params: { command: "curl https://example.invalid/api/projects/create-with-distributions" },
      sessionKey: "session-1",
      toolCallId: "call-shell",
      operatorRole: "media",
      nowMs: NOW,
      store,
    });
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /INTEGRATION_REQUIRED/);
  });

  it("allows manual and scheduled ingest only after the matching current sync", async () => {
    const manualStore = createRuntimeStateStore({ now: () => NOW });
    manualStore.set("session-1", {
      phase: "recovering",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      manualRecoveryConfirmedAt: NOW,
      lastSync: { at: NOW, lifecycle_status: "waiting_return", response_status: "partial", trigger: "manual" },
    });
    const manual = await runBeforeToolCallGuards({
      toolName: "ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "manual" },
      sessionKey: "session-1",
      toolCallId: "call-ingest-manual",
      operatorRole: "media",
      recoveryTrigger: "manual",
      nowMs: NOW,
      store: manualStore,
    });
    assert.equal(manual, undefined);

    const scheduledStore = createRuntimeStateStore({ now: () => NOW });
    scheduledStore.set("session-2", {
      phase: "recovering",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      lastSync: { at: NOW, lifecycle_status: "waiting_return", response_status: "partial", trigger: "scheduled" },
    });
    const scheduled = await runBeforeToolCallGuards({
      toolName: "ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "scheduled" },
      sessionKey: "session-2",
      toolCallId: "call-ingest-scheduled",
      operatorRole: "media",
      trigger: "cron",
      nowMs: NOW,
      store: scheduledStore,
    });
    assert.equal(scheduled, undefined);

    const outsideCron = await runBeforeToolCallGuards({
      toolName: "ingest_mcn_submissions",
      params: { mcn_recommendation_id: "mcnr-1", requirement_id: "req-1", trigger: "scheduled" },
      sessionKey: "session-2",
      toolCallId: "call-ingest-invalid",
      operatorRole: "media",
      nowMs: NOW,
      store: scheduledStore,
    });
    assert.equal(outsideCron?.block, true);
    assert.match(outsideCron?.blockReason ?? "", /RECOVERY_NOT_CONFIRMED/);
  });

  it("blocks ranking until an authoritative final sync reports recovered", async () => {
    const store = createRuntimeStateStore({ now: () => NOW });
    store.set("session-1", {
      phase: "recovery_sync_pending",
      requirement_id: "req-1",
      mcn_recommendation_id: "mcnr-1",
      lastSync: { at: NOW, lifecycle_status: "recovering", response_status: "partial", trigger: "manual" },
      lastIngest: { at: NOW, ingest_batch_id: "ingest-1", trigger: "manual" },
    });
    const result = await runBeforeToolCallGuards({
      toolName: "rank_creators",
      params: { mcn_recommendation_id: "mcnr-1" },
      sessionKey: "session-1",
      toolCallId: "call-rank",
      operatorRole: "media",
      nowMs: NOW,
      store,
    });
    assert.equal(result?.block, true);
    assert.match(result?.blockReason ?? "", /INVALID_PHASE/);
  });
});
